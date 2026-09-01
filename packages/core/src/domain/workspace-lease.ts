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
  /**
   * What the host can observe about that process id's own start, so a later process that the
   * kernel gave the same id is not mistaken for it. `null` where the host cannot observe one.
   */
  startMarker: string | null
  /**
   * The process namespace the id belongs to. Process ids mean nothing across one — two containers
   * sharing a workspace root each see their own — so a host only probes an owner recorded in its
   * own. `null` where the host cannot identify one, which is every host without `/proc`.
   */
  namespace: string | null
  /**
   * The boot the id belongs to, as the kernel names it — a value unique to one boot of one machine,
   * so two hosts that agree on it are looking at the same process table. `null` where the host
   * cannot read one.
   */
  boot: string | null
}>

/**
 * What a host can see of a recorded owner now.
 *
 * `Unobservable` is the answer whenever the owner's process ids are not this host's to read —
 * another process namespace, or one neither side could identify. `Running` carries the observed
 * start marker, which is `null` where the host cannot read one; a process that is running is then
 * taken at face value.
 */
export type OwnerObservation =
  | Readonly<{ _tag: 'Unobservable' }>
  | Readonly<{ _tag: 'Gone' }>
  | Readonly<{ _tag: 'Running'; startMarker: string | null }>

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
    startMarker: Schema.NullOr(Schema.String),
    namespace: Schema.NullOr(Schema.String),
    boot: Schema.NullOr(Schema.String),
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
 * How long a held lease whose owner this host cannot observe is still treated as claimed.
 *
 * A run is bounded by turn, stall and retry timeouts measured in minutes, so a lease still held a
 * week later belongs to a host that is not coming back — whatever platform it ran on, and whether
 * or not this host could ever have observed its process. It is the one rule that reclaims a crashed
 * host's workspaces where the kernel offers no identity to compare, and it is set far past any run
 * so that it can never take a live one.
 */
export const unobservableLeaseLifetimeMs = 7 * 24 * 60 * 60 * 1_000

/**
 * Whether a lease still belongs to a live owner, and so whether the workspace it holds may be
 * entered or removed by anyone else.
 *
 * A record this host wrote is claimed while it says so: within one process the release is what
 * clears it. A record another host wrote is claimed while that host's process is still running,
 * which is how a second host pointed at the same root is respected and how a crashed one stops
 * blocking cleanup.
 *
 * Only an owner this host can actually observe is ever concluded to be gone from its process alone.
 * A process id means nothing outside the namespace that issued it, and nothing at all on another
 * machine, so an owner the host cannot place — another container, another kernel, or a platform
 * that names neither — stays claimed rather than being probed against whatever process happens to
 * carry that id here. What reclaims those is age: past `unobservableLeaseLifetimeMs`, a held lease
 * no one can observe is no longer treated as one.
 *
 * Within one namespace, a process id alone still does not identify a process: a host restarted into
 * the same id, the ordinary case for a container's PID 1, would otherwise keep its predecessor's
 * leases alive for as long as it ran. So a running process whose start marker is not the recorded
 * one is a different process, and the lease it left is not claimed. Where either marker is missing
 * the observation cannot tell them apart, and the owner is taken to be running, because refusing to
 * remove a workspace is the safe error.
 */
export const leaseIsClaimed = (
  lease: WorkspaceLeaseRecord,
  hostId: string,
  observation: OwnerObservation,
  now: Date,
): boolean => {
  if (lease.status !== 'held') {
    return false
  }
  if (lease.owner.hostId === hostId) {
    return true
  }
  if (observation._tag === 'Unobservable') {
    return now.getTime() - Date.parse(lease.acquiredAt) < unobservableLeaseLifetimeMs
  }
  if (observation._tag === 'Gone') {
    return false
  }
  return (
    observation.startMarker === null ||
    lease.owner.startMarker === null ||
    observation.startMarker === lease.owner.startMarker
  )
}
