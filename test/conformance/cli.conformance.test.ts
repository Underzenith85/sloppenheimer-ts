import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'

type ProcessResult = Readonly<{
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}>

const runCli = async (
  arguments_: readonly string[],
  terminateWhenReady = false,
): Promise<ProcessResult> => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...arguments_], {
    cwd: process.cwd(),
    env: { ...process.env, SLOPPENHEIMER_CONFORMANCE_TOKEN: 'not-a-real-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const exited = new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error('CLI did not exit within five seconds'))
    }, 15_000)
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolvePromise({ code, signal, stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
  if (terminateWhenReady) {
    const deadline = Date.now() + 10_000
    while (
      child.exitCode === null &&
      child.signalCode === null &&
      !Buffer.concat(stdout).toString('utf8').includes('sloppenheimer host started') &&
      Date.now() < deadline
    ) {
      await delay(25)
    }
    if (!Buffer.concat(stdout).toString('utf8').includes('sloppenheimer host started')) {
      child.kill('SIGKILL')
      throw new Error('CLI did not become ready within ten seconds')
    }
    child.kill('SIGTERM')
  }
  return exited
}

describe('Core Conformance CLI and host lifecycle', (): void => {
  it('surfaces a missing explicit workflow and exits nonzero', async (): Promise<void> => {
    const result = await runCli(['/definitely/missing/WORKFLOW.md'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('cannot read workflow file')
  })

  it('starts with an isolated workflow and exits successfully on SIGTERM', async (): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppenheimer-cli-conformance-'))
    const workflowPath = join(directory, 'WORKFLOW.md')
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github
  provider:
    owner: conformance
    repository: isolated
    token: $SLOPPENHEIMER_CONFORMANCE_TOKEN
  active_states: []
  terminal_states: []
workspace:
  root: ${JSON.stringify(join(directory, 'workspaces'))}
---
Do nothing.
`,
      'utf8',
    )
    await chmod(directory, 0o700)
    try {
      const result = await runCli([workflowPath], true)
      expect(result.code).toBe(0)
      expect(result.signal).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
