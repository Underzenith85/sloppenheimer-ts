import { describe, expect, it } from 'vitest'

import {
  newestFirst,
  workspacesToEvict,
  type RetainedWorkspace,
} from '@sloppenheimer/core/domain/workspace-retention.js'

/**
 * The cap on an issue's retained workspaces is a rule over what the host could read of each one,
 * exercised here without a filesystem or a process table. Whether a record's writer is still there
 * is the adapter's question; what its answer permits is decided below.
 */

const released = Date.UTC(2026, 8, 1, 10, 0)

/** One workspace this host let go of `minutesAgo` before the newest. */
const workspace = (runId: number, minutesAgo: number, ownerFinished = true): RetainedWorkspace => ({
  key: `run-${String(runId)}-hosta`,
  retainedAt: released - minutesAgo * 60_000,
  runId,
  ownerFinished,
})

describe('retained workspace ordering', (): void => {
  it('orders by release time, then run number, whatever order the directory listed them in', (): void => {
    const listed = [workspace(2, 5), workspace(4, 0), workspace(3, 0), workspace(1, 10)]

    expect(newestFirst(listed).map((entry) => entry.runId)).toEqual([4, 3, 2, 1])
  })

  it('sorts a workspace nothing dates oldest, whatever its key', (): void => {
    // A run directory with no lease beside it: a host killed between taking the record aside and
    // putting it back leaves one, and no record stands over it.
    const undated: RetainedWorkspace = {
      key: 'run-9-hosta',
      retainedAt: null,
      runId: null,
      ownerFinished: true,
    }

    expect(newestFirst([undated, workspace(1, 30)]).map((entry) => entry.key)).toEqual([
      'run-1-hosta',
      'run-9-hosta',
    ])
  })
})

describe('retained workspace eviction', (): void => {
  const retention = { limit: 2, protectedKeys: new Set<string>() }

  it('evicts everything past the newest limit', (): void => {
    const retained = [workspace(1, 30), workspace(2, 20), workspace(3, 10), workspace(4, 0)]

    expect(workspacesToEvict(retained, retention)).toEqual(['run-2-hosta', 'run-1-hosta'])
  })

  it('evicts nothing while the issue holds no more than the limit', (): void => {
    expect(workspacesToEvict([workspace(1, 10), workspace(2, 0)], retention)).toEqual([])
    expect(workspacesToEvict([], retention)).toEqual([])
  })

  it('never evicts a protected workspace, which still occupies its place in the order', (): void => {
    const retained = [workspace(1, 30), workspace(2, 20), workspace(3, 10), workspace(4, 0)]

    // Run 2 is past the cap and protected: it stays, and run 1 behind it still goes.
    expect(
      workspacesToEvict(retained, { limit: 2, protectedKeys: new Set(['run-2-hosta']) }),
    ).toEqual(['run-1-hosta'])
  })

  it('never evicts a workspace whose owner may still want it, and counts it against the cap', (): void => {
    const retained = [
      workspace(1, 30),
      workspace(2, 20, false),
      workspace(3, 10),
      workspace(4, 0, false),
    ]

    // Runs 4 and 2 are another live host's. The newest of them fills one of the two places the
    // cap keeps, and the older one is past the cap but stays; only this host's own run 1 goes.
    expect(workspacesToEvict(retained, { limit: 2, protectedKeys: new Set() })).toEqual([
      'run-1-hosta',
    ])
  })

  it('keeps at least the newest one whatever the limit says', (): void => {
    const retained = [workspace(1, 10), workspace(2, 0)]

    expect(workspacesToEvict(retained, { limit: 0, protectedKeys: new Set() })).toEqual([
      'run-1-hosta',
    ])
  })
})
