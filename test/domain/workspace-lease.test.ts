import { Either, Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { issueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import {
  decodeLease,
  encodeLease,
  heldLease,
  leaseIsClaimed,
  retainedLease,
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

const owner: WorkspaceOwner = { hostId: 'host-a', processId: 4242, startMarker: '918273' }
const running = (startMarker: string | null): OwnerObservation => ({ _tag: 'Running', startMarker })
const gone: OwnerObservation = { _tag: 'Gone' }
const acquiredAt = new Date('2026-08-31T10:00:00.000Z')
const releasedAt = new Date('2026-08-31T10:05:00.000Z')

const lease = heldLease(
  { identifier: issueIdentifier('owner/repository#166'), runId: 7 },
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
    expect(leaseIsClaimed(lease, 'host-a', gone)).toBe(true)
    expect(
      leaseIsClaimed(retainedLease(lease, 'released', releasedAt), 'host-a', running('918273')),
    ).toBe(false)
  })

  it('is claimed by another host only while that host is running', (): void => {
    expect(leaseIsClaimed(lease, 'host-b', running('918273'))).toBe(true)
    expect(leaseIsClaimed(lease, 'host-b', gone)).toBe(false)
  })

  it('is not claimed by a process that merely inherited the recorded id', (): void => {
    // The ordinary case is a host restarted into the same id, which a container's PID 1 always is.
    expect(leaseIsClaimed(lease, 'host-b', running('554433'))).toBe(false)
  })

  it('takes a running owner at face value when either marker is missing', (): void => {
    expect(leaseIsClaimed(lease, 'host-b', running(null))).toBe(true)
    expect(
      leaseIsClaimed(
        { ...lease, owner: { ...owner, startMarker: null } },
        'host-b',
        running('554433'),
      ),
    ).toBe(true)
  })
})
