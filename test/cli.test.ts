import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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

const spawnCli = (cwd: string, arguments_: readonly string[]): CliProcess => {
  const child = spawn(process.execPath, ['--import', tsxImport, cliPath, ...arguments_], {
    cwd,
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
