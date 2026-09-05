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
}>

/**
 * What the reading host says about a record that names the reading host: whether it is one this
 * process still has. A published record is held while the run holding it has not let go; a record
 * still being staged is held because it is on its way to being published.
 */
export type OwnHostLease = Readonly<{ hostId: string; stillHeld: boolean }>

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
 * Whether a lease record is the one this run published: still held, and naming this run on this
 * host. A record that is another run's, or one already released, is not this run's to rewrite —
 * which is what keeps a release from writing over a workspace someone else has since taken.
 */
export const leaseNamesRun = (
  lease: WorkspaceLeaseRecord,
  run: WorkspaceRun,
  runKey: string,
  hostId: string,
): boolean =>
  lease.status === 'held' &&
  lease.runKey === runKey &&
  lease.runId === run.runId &&
  lease.identifier === run.identifier &&
  lease.owner.hostId === hostId

/**
 * Whether a lease still belongs to a live owner, and so whether the workspace it holds may be
 * entered or removed by anyone else.
 *
 * A record this host wrote is claimed while this host still has it — which is the caller's to say,
 * not the record's. Releasing rewrites the record, and a release whose write does not land would
 * otherwise leave a record naming a live process for a run that has ended, which nothing in this
 * process could ever take back. A record another host wrote is claimed while that host's process is
 * still running, which is how a second host pointed at the same root is respected and how a crashed
 * one stops blocking cleanup.
 *
 * Nothing here is decided by time. A lease is given up by the run that holds it, or taken from a
 * host that can be seen to be gone — never waited out. A host restarted into its predecessor's
 * process id, which is the ordinary case for a container's PID 1, is exactly what makes a process
 * id alone insufficient: a running process whose start marker is not the recorded one is a
 * different process, and the lease it left is not claimed. Where either marker is missing the
 * observation cannot tell them apart, and the owner is taken to be running.
 *
 * An owner this host cannot place at all — another container, another kernel, or a platform that
 * names neither — stays claimed, and stays claimed for good. Its workspace is a retained artifact
 * that cleanup reports and never takes. That is the deliberate limit of this rule: refusing to
 * remove a workspace is the safe error, and there is no honest way to tell a peer that has crashed
 * from one that is working, when the kernel will not say and clocks are not shared. Do not replace
 * it with an expiry. Two hosts do not share a wall clock, and a lease waited out on the reader's
 * clock is a live run's workspace deleted underneath it.
 */
export const leaseIsClaimed = (
  lease: WorkspaceLeaseRecord,
  ownHost: OwnHostLease,
  observation: OwnerObservation,
): boolean => {
  if (lease.status !== 'held') {
    return false
  }
  if (lease.owner.hostId === ownHost.hostId) {
    return ownHost.stillHeld
  }
  return !ownerIsGone(lease.owner, observation)
}

/**
 * Whether an observation shows a recorded owner to be gone: its process is not there, or the
 * process carrying its id started at a different instant and so is a successor the kernel handed
 * the id to. A process that cannot be told apart from the owner — either start marker missing — is
 * taken to be it, and an owner this host cannot observe at all is never concluded to be gone.
 *
 * This is the one reading of an observation. `leaseIsClaimed` uses it for a held lease; the
 * retention cap uses it for a released one, where the question is not who holds the workspace but
 * whether the host that kept it could still mean to come back for it.
 */
export const ownerIsGone = (owner: WorkspaceOwner, observation: OwnerObservation): boolean => {
  switch (observation._tag) {
    case 'Unobservable':
      return false
    case 'Gone':
      return true
    case 'Running':
      return (
        observation.startMarker !== null &&
        owner.startMarker !== null &&
        observation.startMarker !== owner.startMarker
      )
  }
}
