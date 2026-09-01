import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { Option } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  parseProcessStatus,
  processGroupIsAlive,
  terminateChildProcess,
} from '@sloppenheimer/core/support/subprocess.js'

const children: ChildProcess[] = []

afterEach((): void => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group is already gone.
      }
    }
  }
})

/**
 * A detached shell that exits on `SIGTERM` while a descendant of the same process group ignores it,
 * resolved once the tree has announced itself.
 */
const spawnIgnoringTree = async (): Promise<Readonly<{ child: ChildProcess; pid: number }>> => {
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
  const { pid } = child
  if (pid === undefined) {
    throw new Error('the test tree did not start')
  }
  const lines = createInterface({ input: child.stdout })
  await new Promise<void>((resolve) => {
    lines.once('line', () => resolve())
  })
  return { child, pid }
}

const exitOf = (child: ChildProcess): Promise<void> =>
  new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
}

describe('process group liveness', (): void => {
  it('reports a group whose descendant still runs as alive', async (): Promise<void> => {
    const { child, pid } = await spawnIgnoringTree()

    expect(processGroupIsAlive(pid)).toBe(true)

    // The leader exits on SIGTERM; the descendant ignores it and keeps the group alive.
    const exited = exitOf(child)
    process.kill(-pid, 'SIGTERM')
    await exited

    expect(processGroupIsAlive(pid)).toBe(true)
  })

  it('reports a group left with nothing but zombies as dead', async (): Promise<void> => {
    const { child, pid } = await spawnIgnoringTree()
    const exited = exitOf(child)

    process.kill(-pid, 'SIGKILL')
    await exited

    // The killed descendants may linger as unreaped `Z` entries on a host whose PID 1 does not reap
    // orphans, so the group keeps answering `process.kill(-pid, 0)`; none of them can run again.
    // The verdict needs two passes that agree on the same membership, so a descendant the host
    // reaps between them moves the set and reads as unknown, which every caller takes as alive.
    // Settle first, exactly as the churn case below does, then hold the probe to `false`.
    await waitFor(() => !processGroupIsAlive(pid))
    expect(processGroupIsAlive(pid)).toBe(false)
  })

  it('still reports a zombie-only group as dead while the host churns processes', async (): Promise<void> => {
    // Unrelated short-lived processes come and go throughout every `/proc` pass. The verdict must
    // rest on what the group itself shows: a probe that gave up whenever the host was busy would
    // flap back to alive here, and every escalation built on it would run to its bound again.
    for (const _ of [0, 1]) {
      const churn = spawn('bash', ['-lc', 'while true; do /bin/true; done'], {
        detached: true,
        stdio: 'ignore',
      })
      children.push(churn)
    }
    const { child, pid } = await spawnIgnoringTree()
    const exited = exitOf(child)

    process.kill(-pid, 'SIGKILL')
    await exited
    await waitFor(() => !processGroupIsAlive(pid))

    // Once dead the group cannot come back, so every further read must agree.
    const reads = Array.from({ length: 20 }, () => processGroupIsAlive(pid))

    expect(reads).toEqual(Array.from({ length: 20 }, () => false))
  })

  it('reads the state and process group out of a stat line whose comm has spaces and parens', (): void => {
    expect(
      Option.getOrNull(parseProcessStatus('7 (my (odd) name) Z 1 4242 0 0 -1 4194560 0')),
    ).toEqual({
      state: 'Z',
      processGroup: 4242,
    })
    expect(Option.getOrNull(parseProcessStatus('7 (bash) S 1 7 0 0'))).toEqual({
      state: 'S',
      processGroup: 7,
    })
    expect(Option.isNone(parseProcessStatus('malformed'))).toBe(true)
    expect(Option.isNone(parseProcessStatus('7 (bash) S 1'))).toBe(true)
    expect(Option.isNone(parseProcessStatus('7 (bash) S 1 not-a-number'))).toBe(true)
  })
})

describe('subprocess termination', (): void => {
  it('keeps the force timer when the group leader exits before an ignoring descendant', async (): Promise<void> => {
    const { child, pid } = await spawnIgnoringTree()

    await terminateChildProcess(child, 50)

    expect(processGroupIsAlive(pid)).toBe(false)
  })

  it('settles on the leader exit rather than the bound timer', async (): Promise<void> => {
    const { child } = await spawnIgnoringTree()

    const startedAt = Date.now()
    await terminateChildProcess(child, 50)

    // The bound timer fires a further second after the grace: settling on the leader's exit once
    // the remaining members are zombies has to be well inside that.
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})
