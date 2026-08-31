import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { fakeAppServerCommand } from './harness/fake-app-server.js'
import { processIsAlive } from './harness/processes.js'

const cliPath = resolve('src/cli.ts')
const tsxImport = import.meta.resolve('tsx')
const temporaryDirectories: string[] = []
const servers: Server[] = []
const children: ChildProcess[] = []

type CliProcess = Readonly<{
  child: ChildProcess
  stdout: () => string
  stderr: () => string
}>

type ProcessOutcome = Readonly<{
  code: number | null
  signal: NodeJS.Signals | null
}>

const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise()
      } else {
        rejectPromise(error)
      }
    })
    server.closeAllConnections()
  })

afterEach(async (): Promise<void> => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  await Promise.all(servers.splice(0).map(closeServer))
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

const listen = (server: Server): Promise<number> =>
  new Promise<number>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectPromise)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        rejectPromise(new Error('test server did not expose a TCP address'))
      } else {
        resolvePromise(address.port)
      }
    })
  })

const makeTrackerServer = async (): Promise<number> => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('[]')
  })
  servers.push(server)
  return listen(server)
}

const reserveOperatorPort = async (): Promise<number> => {
  const server = createServer()
  const port = await listen(server)
  await closeServer(server)
  return port
}

const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'symphony-cli-'))
  temporaryDirectories.push(directory)
  return directory
}

const writeWorkflow = async (directory: string, name = 'WORKFLOW.md'): Promise<string> => {
  const trackerPort = await makeTrackerServer()
  const path = join(directory, name)
  await writeFile(
    path,
    `---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $SYMPHONY_CLI_TEST_TOKEN
    api_base_url: http://127.0.0.1:${String(trackerPort)}
polling:
  interval_ms: 60000
workspace:
  root: ./workspaces
---
Work on {{ issue.identifier }}.
`,
  )
  return path
}

const spawnCli = (cwd: string, arguments_: readonly string[], detached = false): CliProcess => {
  const child = spawn(process.execPath, ['--import', tsxImport, cliPath, ...arguments_], {
    cwd,
    detached,
    env: { ...process.env, SYMPHONY_CLI_TEST_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  return { child, stdout: () => stdout, stderr: () => stderr }
}

const waitForExit = (child: ChildProcess, timeoutMs = 8_000): Promise<ProcessOutcome> =>
  new Promise<ProcessOutcome>((resolvePromise, rejectPromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ code: child.exitCode, signal: child.signalCode })
      return
    }
    const timeout = setTimeout(() => {
      rejectPromise(new Error('CLI did not exit in time'))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectPromise(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolvePromise({ code, signal })
    })
  })

const waitForReady = async (port: number): Promise<void> => {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/state`)
      if (response.status === 200) {
        return
      }
    } catch {
      // The listener is still starting.
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 25)
    })
  }
  throw new Error('CLI did not become ready in time')
}

/**
 * A GitHub stand-in that hands out open, dispatchable issues. It answers dependency hydration with
 * an empty list so every issue is immediately ready, which is what lets the host fill its
 * concurrency limit.
 */
const makeIssueTrackerServer = async (count: number): Promise<number> => {
  const issues = Array.from({ length: count }, (_unused, index) => {
    const number = index + 1
    return {
      number,
      node_id: `issue-${String(number)}`,
      title: `Stubborn issue ${String(number)}`,
      body: null,
      state: 'open',
      html_url: `https://example.test/issues/${String(number)}`,
      labels: [{ name: 'ready' }],
      created_at: '2026-08-30T00:00:00Z',
      updated_at: '2026-08-30T00:00:00Z',
    }
  })
  const single = /\/issues\/(\d+)$/u
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    const path = request.url ?? ''
    if (path.includes('/issues?')) {
      response.end(JSON.stringify(issues))
      return
    }
    const match = single.exec(path)
    const issue = match?.[1] === undefined ? undefined : issues[Number(match[1]) - 1]
    response.end(JSON.stringify(issue ?? []))
  })
  servers.push(server)
  return listen(server)
}

/**
 * A workflow whose agent command is a fake App Server that leaves a descendant ignoring `SIGTERM`.
 * Cleaning one up costs the full escalation grace, so `concurrency` of them is exactly the case
 * that used to overrun the CLI's shutdown watchdog.
 */
const writeStubbornWorkflow = async (directory: string, concurrency: number): Promise<string> => {
  const trackerPort = await makeIssueTrackerServer(concurrency)
  const path = join(directory, 'WORKFLOW.md')
  await writeFile(
    path,
    `---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $SYMPHONY_CLI_TEST_TOKEN
    api_base_url: http://127.0.0.1:${String(trackerPort)}
  required_labels: [ready]
  active_states: [open]
  terminal_states: [closed]
polling:
  interval_ms: 3600000
workspace:
  root: ./workspaces
agent:
  max_concurrent_agents: ${String(concurrency)}
  max_turns: 1
codex:
  command: ${JSON.stringify(
    fakeAppServerCommand('stubborn-grandchild', {
      approvalPolicy: 'never',
      threadSandbox: 'workspace-write',
      turnSandboxPolicy: null,
      acceptAnyDynamicTools: true,
    }),
  )}
  stall_timeout_ms: 600000
---
Work on {{ issue.identifier }}.
`,
  )
  return path
}

const waitForRunning = async (port: number, expected: number): Promise<void> => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/state`)
      if (response.status === 200) {
        const snapshot = (await response.json()) as { counts?: { running?: number } }
        if ((snapshot.counts?.running ?? 0) >= expected) {
          return
        }
      }
    } catch {
      // The listener is still starting.
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 50)
    })
  }
  throw new Error('the host did not reach the expected agent count in time')
}

/** Every descendant pid the fake App Servers recorded in their workspaces. */
const recordedDescendants = async (directory: string): Promise<readonly number[]> => {
  const root = join(directory, 'workspaces')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const pids: number[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const recorded = await readFile(join(root, entry.name, 'grandchild.pid'), 'utf8').catch(
      () => null,
    )
    if (recorded !== null) {
      pids.push(Number(recorded.trim()))
    }
  }
  return pids
}

const waitForDescendants = async (
  directory: string,
  expected: number,
): Promise<readonly number[]> => {
  const deadline = Date.now() + 20_000
  let recorded = await recordedDescendants(directory)
  while (recorded.length < expected && Date.now() < deadline) {
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 50)
    })
    recorded = await recordedDescendants(directory)
  }
  return recorded
}

/**
 * Drives one signal-driven shutdown of a host with several stubborn agents and reports what the
 * assertions need. Both the `SIGINT` and the `SIGTERM` case use it, so the second costs one call
 * rather than a second copy of the fixture.
 */
const shutdownWithActiveWorkers = async (
  signal: 'SIGINT' | 'SIGTERM',
  concurrency: number,
): Promise<
  Readonly<{
    outcome: ProcessOutcome
    stderr: string
    elapsedMs: number
    operatorPort: number
    descendants: readonly number[]
  }>
> => {
  const directory = await makeDirectory()
  const workflowPath = await writeStubbornWorkflow(directory, concurrency)
  const operatorPort = await reserveOperatorPort()
  const process_ = spawnCli(directory, [workflowPath, '--port', String(operatorPort)], true)

  await waitForRunning(operatorPort, concurrency)
  // Wait until every agent's App Server has actually forked the descendant that ignores SIGTERM:
  // dispatch alone would leave nothing stubborn to clean up.
  const descendants = await waitForDescendants(directory, concurrency)
  const startedAt = Date.now()
  // The signal goes to the whole process group, the way a terminal delivers Ctrl-C.
  process.kill(-(process_.child.pid ?? 0), signal)
  const outcome = await waitForExit(process_.child, 25_000)
  return {
    outcome,
    stderr: process_.stderr(),
    elapsedMs: Date.now() - startedAt,
    operatorPort,
    descendants,
  }
}

describe('CLI host lifecycle', (): void => {
  it('uses an explicit workflow path and exits zero after SIGINT', async (): Promise<void> => {
    const directory = await makeDirectory()
    const workflowPath = await writeWorkflow(directory, 'explicit.md')
    const operatorPort = await reserveOperatorPort()
    const process_ = spawnCli(directory, [workflowPath, '--port', String(operatorPort)])

    await waitForReady(operatorPort)
    process_.child.kill('SIGINT')
    const outcome = await waitForExit(process_.child)

    expect(outcome).toEqual({ code: 0, signal: null })
    expect(process_.stderr()).toBe('')
  })

  it('uses cwd WORKFLOW.md and exits zero after SIGTERM', async (): Promise<void> => {
    const directory = await makeDirectory()
    await writeWorkflow(directory)
    const operatorPort = await reserveOperatorPort()
    const process_ = spawnCli(directory, ['--port', String(operatorPort)])

    await waitForReady(operatorPort)
    process_.child.kill('SIGTERM')
    const outcome = await waitForExit(process_.child)

    expect(outcome).toEqual({ code: 0, signal: null })
    expect(process_.stderr()).toBe('')
  })

  it('rejects invalid and extra arguments with concise nonzero errors', async (): Promise<void> => {
    const directory = await makeDirectory()
    const invalid = spawnCli(directory, ['--unknown'])
    const invalidOutcome = await waitForExit(invalid.child)
    const extra = spawnCli(directory, ['one.md', 'two.md'])
    const extraOutcome = await waitForExit(extra.child)

    expect(invalidOutcome.code).toBe(1)
    expect(invalid.stderr()).toBe('symphony: unknown option: --unknown\n')
    expect(extraOutcome.code).toBe(1)
    expect(extra.stderr()).toBe('symphony: only one workflow path may be provided\n')
  })

  it('rejects missing explicit and default workflow paths concisely', async (): Promise<void> => {
    const directory = await makeDirectory()
    const explicitPath = join(directory, 'missing.md')
    const explicit = spawnCli(directory, [explicitPath])
    const explicitOutcome = await waitForExit(explicit.child)
    const default_ = spawnCli(directory, [])
    const defaultOutcome = await waitForExit(default_.child)

    expect(explicitOutcome.code).toBe(1)
    expect(explicit.stderr()).toBe(`symphony: cannot read workflow file: ${explicitPath}\n`)
    expect(defaultOutcome.code).toBe(1)
    expect(default_.stderr()).toBe(
      `symphony: cannot read workflow file: ${join(directory, 'WORKFLOW.md')}\n`,
    )
  })

  it('closes a host with four stubborn workers and frees the operator port', async (): Promise<void> => {
    const concurrency = 4
    const result = await shutdownWithActiveWorkers('SIGINT', concurrency)

    // A graceful close exits zero and says nothing; the watchdog would exit 1 after printing.
    expect(result.outcome).toEqual({ code: 0, signal: null })
    expect(result.stderr).toBe('')
    expect(result.stderr).not.toContain('shutdown did not complete')
    // Cleanup is bounded by the slowest single agent, not by the number of them.
    expect(result.elapsedMs).toBeLessThan(10_000)

    // The listener is free the moment the host is gone.
    const replacement = createServer()
    servers.push(replacement)
    await new Promise<void>((resolvePromise, rejectPromise) => {
      replacement.once('error', rejectPromise)
      replacement.listen(result.operatorPort, '127.0.0.1', () => {
        replacement.removeListener('error', rejectPromise)
        resolvePromise()
      })
    })

    expect(result.descendants).toHaveLength(concurrency)
    expect(result.descendants.filter((pid) => processIsAlive(pid))).toEqual([])
  }, 60_000)

  it('closes the same host on SIGTERM', async (): Promise<void> => {
    const result = await shutdownWithActiveWorkers('SIGTERM', 2)

    expect(result.outcome).toEqual({ code: 0, signal: null })
    expect(result.stderr).toBe('')
    expect(result.elapsedMs).toBeLessThan(10_000)
    expect(result.descendants.filter((pid) => processIsAlive(pid))).toEqual([])
  }, 60_000)

  it('exits nonzero when the HTTP listener fails during startup', async (): Promise<void> => {
    const directory = await makeDirectory()
    const workflowPath = await writeWorkflow(directory)
    const occupied = createServer()
    servers.push(occupied)
    const occupiedPort = await listen(occupied)
    const process_ = spawnCli(directory, [workflowPath, '--port', String(occupiedPort)])

    const outcome = await waitForExit(process_.child)

    expect(outcome.code).toBe(1)
    expect(process_.stderr()).toBe('symphony: operator server failed\n')
    expect(process_.stdout()).not.toContain('operator console listening')
  })
})
