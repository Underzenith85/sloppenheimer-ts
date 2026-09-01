import { Either, Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { issueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import {
  decodeLease,
  encodeLease,
  heldLease,
  leaseIsClaimed,
  retainedLease,
  leaseLifetimeFloorMs,
  type OwnerObservation,
  type WorkspaceLeaseRecord,
  type WorkspaceOwner,
} from '@sloppenheimer/core/domain/workspace-lease.js'
import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'

/**
 * The lease rules decide who owns a workspace and what a workspace found on disk means, so they
 * are exercised here without a filesystem or a process table. Whether a recorded owner is still
 * running is the adapter's question; every use the answer is put to is decided below.
 */

const owner: WorkspaceOwner = {
  hostId: 'host-a',
  processId: 4242,
  startMarker: '918273',
  namespace: 'boot-1/pid:[4026531836]',
  boot: 'boot-1',
}
/** While the run that took the lease could still plausibly be running. */
const soonAfter = new Date('2026-08-31T10:30:00.000Z')
const running = (startMarker: string | null): OwnerObservation => ({ _tag: 'Running', startMarker })
const gone: OwnerObservation = { _tag: 'Gone' }
const unobservable: OwnerObservation = { _tag: 'Unobservable' }
const acquiredAt = new Date('2026-08-31T10:00:00.000Z')
const releasedAt = new Date('2026-08-31T10:05:00.000Z')

const lease = heldLease(
  {
    identifier: issueIdentifier('owner/repository#166'),
    runId: 7,
    lifetimeMs: leaseLifetimeFloorMs,
  },
  'run-7-hosta',
  owner,
  acquiredAt,
)

const decoded = (document: string): WorkspaceLeaseRecord =>
  Either.getOrThrowWith(decodeLease('/workspaces/GH-1/run-7-hosta.lease', document), (error) => {
    throw error
  })

const rejection = (document: string): WorkspaceError => {
  const result = decodeLease('/workspaces/GH-1/run-7-hosta.lease', document)
  expect(Either.isLeft(result)).toBe(true)
  const error = Option.getOrThrow(Either.getLeft(result))
  expect(error).toBeInstanceOf(WorkspaceError)
  expect(error.category).toBe('inspect_failed')
  return error
}

describe('workspace lease records', (): void => {
  it('names the issue, the run and the host that holds it', (): void => {
    expect(lease).toEqual({
      version: 1,
      identifier: 'owner/repository#166',
      runId: 7,
      runKey: 'run-7-hosta',
      owner,
      status: 'held',
      reason: null,
      acquiredAt: '2026-08-31T10:00:00.000Z',
      // A lease states when the run that took it can no longer be running, by its own workflow's
      // limits, so a host that cannot observe the owner waits out that run rather than guessing.
      expiresAt: new Date(acquiredAt.getTime() + leaseLifetimeFloorMs).toISOString(),
      releasedAt: null,
    })
  })

  it('keeps that identity when the run is released and the workspace kept', (): void => {
    const retained = retainedLease(lease, 'run failed before publication', releasedAt)

    expect(retained).toMatchObject({
      identifier: lease.identifier,
      runId: lease.runId,
      owner,
      status: 'retained',
      reason: 'run failed before publication',
      releasedAt: '2026-08-31T10:05:00.000Z',
    })
  })

  it('round-trips through the document written beside the workspace', (): void => {
    expect(decoded(encodeLease(lease))).toEqual(lease)
    expect(decoded(encodeLease(retainedLease(lease, 'cancelled', releasedAt)))).toEqual(
      retainedLease(lease, 'cancelled', releasedAt),
    )
  })

  it('refuses a document that is not a lease rather than reading it as absence', (): void => {
    expect(rejection('not json at all').message).toContain('is not JSON')
    expect(rejection('{}').message).toContain('is malformed')
    expect(rejection(JSON.stringify({ ...lease, version: 2 })).message).toContain('is malformed')
    expect(rejection(JSON.stringify({ ...lease, status: 'abandoned' })).message).toContain(
      'is malformed',
    )
    expect(rejection(JSON.stringify({ ...lease, acquiredAt: 'whenever' })).message).toContain(
      'is malformed',
    )
  })
})

describe('who a lease belongs to', (): void => {
  it('is claimed while the host that wrote it says so', (): void => {
    expect(leaseIsClaimed(lease, 'host-a', gone, soonAfter)).toBe(true)
    expect(
      leaseIsClaimed(
        retainedLease(lease, 'released', releasedAt),
        'host-a',
        running('918273'),
        soonAfter,
      ),
    ).toBe(false)
  })

  it('is claimed by another host only while that host is running', (): void => {
    expect(leaseIsClaimed(lease, 'host-b', running('918273'), soonAfter)).toBe(true)
    expect(leaseIsClaimed(lease, 'host-b', gone, soonAfter)).toBe(false)
  })

  it('is not claimed by a process that merely inherited the recorded id', (): void => {
    // The ordinary case is a host restarted into the same id, which a container's PID 1 always is.
    expect(leaseIsClaimed(lease, 'host-b', running('554433'), soonAfter)).toBe(false)
  })

  it('leaves an owner this host cannot observe alone', (): void => {
    // Two containers sharing a workspace root read their own process ids, not each other's, so an
    // owner in another namespace is never concluded to be gone.
    expect(leaseIsClaimed(lease, 'host-b', unobservable, soonAfter)).toBe(true)
    expect(
      leaseIsClaimed(
        retainedLease(lease, 'released', releasedAt),
        'host-b',
        unobservable,
        soonAfter,
      ),
    ).toBe(false)
  })

  it('stops claiming an unobservable owner once no run could still be holding it', (): void => {
    // The one rule that reclaims a crashed host's workspaces where the kernel names nothing to
    // compare — and it waits out the run the owner was configured for, which the lease states.
    const muchLater = new Date(Date.parse(lease.expiresAt) + 1_000)

    expect(leaseIsClaimed(lease, 'host-b', unobservable, muchLater)).toBe(false)
    expect(leaseIsClaimed(lease, 'host-b', running('918273'), muchLater)).toBe(true)
  })

  it('takes a running owner at face value when either marker is missing', (): void => {
    expect(leaseIsClaimed(lease, 'host-b', running(null), soonAfter)).toBe(true)
    expect(
      leaseIsClaimed(
        { ...lease, owner: { ...owner, startMarker: null } },
        'host-b',
        running('554433'),
        soonAfter,
      ),
    ).toBe(true)
  })
})
