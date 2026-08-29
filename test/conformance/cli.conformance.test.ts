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
  terminateAfterMs: number | null = null,
): Promise<ProcessResult> => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...arguments_], {
    cwd: process.cwd(),
    env: { ...process.env, SYMPHONY_CONFORMANCE_TOKEN: 'not-a-real-token' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const exited = new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error('CLI did not exit within five seconds'))
    }, 5_000)
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolvePromise({ code, signal, stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
  if (terminateAfterMs !== null) {
    await delay(terminateAfterMs)
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
    const directory = await mkdtemp(join(tmpdir(), 'symphony-cli-conformance-'))
    const workflowPath = join(directory, 'WORKFLOW.md')
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github
  provider:
    owner: conformance
    repository: isolated
    token: $SYMPHONY_CONFORMANCE_TOKEN
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
      const result = await runCli([workflowPath], 1_000)
      expect(result.code).toBe(0)
      expect(result.signal).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
