import { describe, expect, it } from 'vitest'

import { issueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import {
  heldLease,
  retainedLease,
  type WorkspaceLeaseRecord,
  type WorkspaceOwner,
} from '@sloppenheimer/core/domain/workspace-lease.js'
import {
  newestFirst,
  workspacesToEvict,
  type RetainedWorkspace,
} from '@sloppenheimer/core/domain/workspace-retention.js'

/**
 * The cap on an issue's retained workspaces is a rule over lease records, exercised here without a
 * filesystem or a process table. Whether a record's writer is still there is the adapter's
 * question; what its answer permits is decided below.
 */

const owner: WorkspaceOwner = {
  hostId: 'host-a',
  processId: 4242,
  startMarker: '918273',
  namespace: 'boot-1/pid:[4026531836]',
}
const identifier = issueIdentifier('owner/repository#273')

/** A retained record released `minutesAgo` before the newest, from the run number given. */
const retainedRecord = (runId: number, minutesAgo: number): WorkspaceLeaseRecord =>
  retainedLease(
    heldLease(
      { identifier, runId },
      `run-${String(runId)}-hosta`,
      owner,
      new Date(Date.UTC(2026, 8, 1, 9, 0)),
    ),
    'run failed before publication: AgentError process_exited',
    new Date(Date.UTC(2026, 8, 1, 10, 0) - minutesAgo * 60_000),
  )

const workspace = (runId: number, minutesAgo: number, ownerFinished = true): RetainedWorkspace => ({
  key: `run-${String(runId)}-hosta`,
  lease: retainedRecord(runId, minutesAgo),
  ownerFinished,
})

describe('retained workspace ordering', (): void => {
  it('orders by release time, then run number, whatever order the directory listed them in', (): void => {
    const listed = [workspace(2, 5), workspace(4, 0), workspace(3, 0), workspace(1, 10)]

    expect(newestFirst(listed).map((entry) => entry.lease.runId)).toEqual([4, 3, 2, 1])
  })

  it('falls back to the acquisition time for a record with no release time', (): void => {
    const unreleased: RetainedWorkspace = {
      key: 'run-5-hosta',
      lease: { ...retainedRecord(5, 0), releasedAt: null },
      ownerFinished: true,
    }

    // Acquired at 09:00, so it sorts behind everything released at 10:00 and after.
    expect(newestFirst([unreleased, workspace(1, 30)]).map((entry) => entry.lease.runId)).toEqual([
      1, 5,
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
