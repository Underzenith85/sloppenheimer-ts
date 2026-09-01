import { Either, Schema } from 'effect'

import { WorkspaceError } from './errors.js'
import type { IssueIdentifier } from './domain.js'

/**
 * The exclusive lease that makes one run the only owner of one workspace, and the record that
 * outlives it.
 *
 * Ownership used to be the orchestrator's in-memory `running` set, which said nothing after a
 * restart and nothing at all to a second host process pointed at the same workspace root. The
 * lease is a file beside the run directory instead: acquiring it is the exclusive creation of that
 * directory, releasing it either removes the pair or rewrites the record as a retained recovery
 * artifact, and what a later host may do with a workspace is decided by reading the record rather
 * than by inspecting whatever the directory happens to hold.
 *
 * Like `workspace-containment.ts`, this module asks the host nothing. Whether a recorded owner is
 * still running is a question for the adapter; what its answer means is decided here.
 */

/** The host process that acquired a lease. */
export type WorkspaceOwner = Readonly<{
  /** Identifies one host process for as long as it runs, and never a later one. */
  hostId: string
  processId: number
}>

/** The run a lease belongs to. */
export type WorkspaceRun = Readonly<{
  identifier: IssueIdentifier
  runId: number
}>

/**
 * Why a released workspace was kept. A run that published its work needs nothing from the
 * directory afterwards; every other ending leaves work that only the directory holds.
 */
export type WorkspaceRelease =
  | Readonly<{ _tag: 'Completed' }>
  | Readonly<{ _tag: 'Retained'; reason: string }>

const leaseStatus = Schema.Literal('held', 'retained')

const timestamp = Schema.String.pipe(
  Schema.filter((value) => !Number.isNaN(Date.parse(value))),
).annotations({ message: () => 'lease timestamp is not a date string' })

const leaseSchema = Schema.Struct({
  version: Schema.Literal(1),
  identifier: Schema.String,
  runId: Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value) && value >= 0)),
  runKey: Schema.String,
  owner: Schema.Struct({
    hostId: Schema.String,
    processId: Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value))),
  }),
  status: leaseStatus,
  reason: Schema.NullOr(Schema.String),
  acquiredAt: timestamp,
  releasedAt: Schema.NullOr(timestamp),
}).annotations({ message: () => 'workspace lease record is malformed' })

/**
 * A lease as it is written to disk. The record is the recovery artifact's identity: it names the
 * issue, the run and the host, so a directory found later is explained rather than guessed at.
 */
export type WorkspaceLeaseRecord = Schema.Schema.Type<typeof leaseSchema>

export const heldLease = (
  run: WorkspaceRun,
  runKey: string,
  owner: WorkspaceOwner,
  acquiredAt: Date,
): WorkspaceLeaseRecord => ({
  version: 1,
  identifier: run.identifier,
  runId: run.runId,
  runKey,
  owner,
  status: 'held',
  reason: null,
  acquiredAt: acquiredAt.toISOString(),
  releasedAt: null,
})

/** The same lease, released and kept: the run ended without publishing what the directory holds. */
export const retainedLease = (
  lease: WorkspaceLeaseRecord,
  reason: string,
  releasedAt: Date,
): WorkspaceLeaseRecord => ({
  ...lease,
  status: 'retained',
  reason,
  releasedAt: releasedAt.toISOString(),
})

export const encodeLease = (lease: WorkspaceLeaseRecord): string =>
  `${JSON.stringify(lease, null, 2)}\n`

const decodeLeaseRecord = Schema.decodeUnknownEither(leaseSchema)

/**
 * Reads a lease record. A file that is not a lease is a rejection rather than an absence: cleanup
 * must not decide that an unreadable record means the workspace beside it is free.
 */
export const decodeLease = (
  path: string,
  document: string,
): Either.Either<WorkspaceLeaseRecord, WorkspaceError> => {
  const parsed = Either.try(() => JSON.parse(document) as unknown)
  return Either.flatMap(
    Either.mapLeft(
      parsed,
      () =>
        new WorkspaceError({
          category: 'inspect_failed',
          message: `workspace lease is not JSON: ${path}`,
        }),
    ),
    (value) =>
      Either.mapLeft(
        decodeLeaseRecord(value),
        (cause) =>
          new WorkspaceError({
            category: 'inspect_failed',
            message: `workspace lease is malformed: ${path}`,
            cause,
          }),
      ),
  )
}

/**
 * Whether a lease still belongs to a live owner, and so whether the workspace it holds may be
 * entered or removed by anyone else.
 *
 * A record this host wrote is claimed while it says so: within one process the release is what
 * clears it. A record another host wrote is claimed while that process is alive, which is how a
 * second host pointed at the same root is respected and how a crashed one stops blocking cleanup.
 * `ownerIsRunning` is the adapter's answer for a foreign owner; when it cannot be established the
 * caller reports the owner as running, because refusing to remove a workspace is the safe error.
 */
export const leaseIsClaimed = (
  lease: WorkspaceLeaseRecord,
  hostId: string,
  ownerIsRunning: boolean,
): boolean => lease.status === 'held' && (lease.owner.hostId === hostId ? true : ownerIsRunning)
