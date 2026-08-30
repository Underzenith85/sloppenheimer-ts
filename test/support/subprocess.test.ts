import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

import { terminateChildProcess } from '../../src/support/subprocess.js'

const processGroupIsAlive = (child: ChildProcess): boolean => {
  if (child.pid === undefined) {
    return false
  }
  try {
    process.kill(-child.pid, 0)
    return true
  } catch {
    return false
  }
}

const children: ChildProcess[] = []

afterEach((): void => {
  for (const child of children.splice(0)) {
    if (processGroupIsAlive(child) && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGKILL')
    }
  }
})

describe('subprocess termination', (): void => {
  it('keeps the force timer when the group leader exits before an ignoring descendant', async (): Promise<void> => {
    const child = spawn(
      'bash',
      [
        '-lc',
        `trap 'exit 0' TERM
(trap '' TERM; while true; do sleep 1; done) &
printf 'ready\\n'
wait`,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    children.push(child)
    const lines = createInterface({ input: child.stdout })
    await new Promise<void>((resolve) => {
      lines.once('line', () => resolve())
    })

    await terminateChildProcess(child, 50)

    expect(processGroupIsAlive(child)).toBe(false)
  })
})
