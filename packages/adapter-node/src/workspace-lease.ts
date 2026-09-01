import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { randomUUID } from 'node:crypto'
import { readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Effect, Either, Exit, Option, Ref } from 'effect'

import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import { realDirectoryExists } from './filesystem.js'
import type { RunWorkspacePaths } from '@sloppenheimer/core/domain/workspace-containment.js'
import {
  leaseIsClaimed,
  leaseIsOurs,
  renewedLease,
  type OwnerObservation,
  type WorkspaceLeaseRecord,
  type WorkspaceOwner,
  type WorkspaceRun,
} from '@sloppenheimer/core/domain/workspace-lease.js'
import { currentInstant } from '@sloppenheimer/core/support/clock.js'
import {
  discardStagedLease,
  publishStagedLease,
  readLease,
  stagedLeasePath,
  withdrawLease,
  writeStagedLease,
} from './workspace-lease-store.js'

/**
 * The host half of the workspace lease: who this process is, whether a lease another process wrote
 * still has an owner, what time the storage under the records says it is, and the renewal by which
 * a run keeps saying its lease stands. What a record means is decided in
 * `domain/workspace-lease.ts`; where the file lives, in `workspace-lease-store.ts`.
 */

/**
 * When a process id's own process started, as the kernel reports it — the field that tells a
 * restarted host apart from the one whose id it inherited.
 *
 * `/proc/<pid>/stat` is Linux's, and the only portable-enough source there is; a host without it
 * reports nothing rather than a value another host could not compare against. The command field can
 * hold spaces and parentheses, so the fields are read after its closing one, where `starttime` is
 * the twentieth.
 */
export const processStartMarker = (processId: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${String(processId)}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] ?? null
  } catch {
    return null
  }
}

/**
 * The process namespace this host's process ids belong to, identified so that another host reading
 * the same workspace root can tell whether its own ids mean the same thing.
 *
 * The namespace inode alone repeats across machines, so it is paired with the kernel's boot
 * identifier: together they name one namespace on one running kernel. Both are Linux's, and a host
 * without them reports nothing rather than a value another host could not compare against.
 */
const processNamespace = (): string | null => {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const namespace = readlinkSync('/proc/self/ns/pid')
    return `${bootId}/${namespace}`
  } catch {
    return null
  }
}

/**
 * This host process, for as long as it runs. A lease naming it is this process's own, whatever the
 * operating system later does with the process id — which is why the identity is generated here
 * rather than taken from the pid alone. It is a module constant, so a workflow reload that rebuilds
 * the workspace manager keeps the same owner and still recognizes the leases it already holds.
 */
export const hostOwner: WorkspaceOwner = {
  hostId: randomUUID(),
  processId: process.pid,
  startMarker: processStartMarker(process.pid),
  namespace: processNamespace(),
}

/**
 * Whether an owner's process ids are this host's to read: the same process namespace, named by both
 * sides and the same.
 *
 * Nothing weaker will do. Two containers can share a kernel and a workspace root while each sees
 * only its own process ids, and the kernel's boot identifier is common to both of them — so a host
 * that fell back to it would probe its own namespace with the other's id and read a stranger's
 * process as the owner, or as gone. A host that cannot name both namespaces reads nobody else's
 * process ids, and leaves those owners to renewal.
 */
const sharesProcessIds = (owner: WorkspaceOwner): boolean =>
  owner.namespace !== null && owner.namespace === hostOwner.namespace

/**
 * What this host can see of a lease's owner now.
 *
 * An owner whose process ids are not this host's to read — another container's namespace, another
 * machine, or a platform that names neither — is unobservable, and is left to the age rule rather
 * than probed against whatever process happens to carry its id here.
 *
 * Otherwise, signal 0 performs the permission and existence checks without delivering anything.
 * `EPERM` means the process exists and belongs to another user, which is still a running owner. Any
 * other refusal is reported as running too: a cleanup that cannot establish an owner is gone must
 * not remove its workspace. A running process is reported with its own start marker, so a process
 * id the kernel handed to a successor is not mistaken for the process that recorded it.
 */
export const observeOwner = (owner: WorkspaceOwner): OwnerObservation => {
  if (!sharesProcessIds(owner)) {
    return { _tag: 'Unobservable' }
  }
  try {
    process.kill(owner.processId, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return { _tag: 'Gone' }
    }
  }
  return { _tag: 'Running', startMarker: processStartMarker(owner.processId) }
}

/**
 * Whether a lease record still belongs to a running owner, as this host sees it now.
 *
 * `unrenewedForMs` is how long the record has gone unwritten, and it is the caller's to measure
 * from the storage the record lives on rather than from this host's wall clock — see
 * `storageInstant`.
 */
export const leaseIsLive = (lease: WorkspaceLeaseRecord, unrenewedForMs: number): boolean =>
  leaseIsClaimed(lease, hostOwner.hostId, observeOwner(lease.owner), unrenewedForMs)

/**
 * What time it is on the storage the leases live on.
 *
 * Whether a lease has gone unrenewed is a duration, and a duration needs one clock. Two hosts
 * sharing a workspace root do not share a wall clock — an hour of skew would have one of them read
 * a lease another is renewing every five minutes as long expired — but they do share the filesystem
 * that stamps their records. So this asks the filesystem what time it thinks it is, by writing a
 * file of its own and reading back the time it was given, and the age of a record is that against
 * the record's own stamp. A filesystem that keeps no times at all answers with nothing, and a
 * caller that cannot measure an age leaves the lease alone.
 */
export const storageInstant = (
  fileSystem: FileSystem.FileSystem,
  stagingPath: string,
): Effect.Effect<Option.Option<number>, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    if (!(yield* realDirectoryExists(fileSystem, stagingPath))) {
      yield* fileSystem.makeDirectory(stagingPath, { recursive: true })
    }
    const probe = join(stagingPath, `${randomUUID()}.now`)
    // The file is taken away by the same bracket that makes it, so nothing accumulates here: an
    // interruption after the write cannot arrive before the removal that answers for it.
    return yield* Effect.acquireUseRelease(
      fileSystem.writeFileString(probe, '', { mode: 0o600 }),
      () =>
        Effect.map(fileSystem.stat(probe), (info) => Option.map(info.mtime, (at) => at.getTime())),
      () => discardStagedLease(fileSystem, probe),
    )
  })

/**
 * How long a lease record has gone unwritten, on that same clock. Every renewal replaces the record
 * with a freshly written one, so its stamp is when the run last said the lease stands.
 */
export const leaseUnrenewedFor = (
  fileSystem: FileSystem.FileSystem,
  leasePath: string,
  storageNow: Option.Option<number>,
): Effect.Effect<Option.Option<number>, PlatformError> =>
  Effect.map(fileSystem.stat(leasePath), (info) =>
    Option.zipWith(storageNow, info.mtime, (now, written) => now - written.getTime()),
  )

/** What a renewal has written but not yet put in place. */
type StagedRenewal = Readonly<{ renewed: WorkspaceLeaseRecord; stoodUntil: number }>

/**
 * Reads the record this run holds and writes its replacement where nothing refers to it yet.
 *
 * `None` where the record is no longer this run's to say — gone, released, another run's, or past
 * its own expiry. Nothing here has changed the lease, so all of it may be interrupted; the caller
 * names the staging file so that an interruption leaves a path it can take away.
 */
const stageRenewal = (
  fileSystem: FileSystem.FileSystem,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  owner: WorkspaceOwner,
  now: Date,
  staged: string,
): Effect.Effect<Option.Option<StagedRenewal>, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    const existing = yield* readLease(fileSystem, paths.leasePath)
    const ours = Option.filter(existing, (lease) =>
      leaseIsOurs(lease, run, paths.runKey, owner.hostId, now),
    )
    if (Option.isNone(ours)) {
      return Option.none<StagedRenewal>()
    }
    const renewed = renewedLease(ours.value, now)
    yield* writeStagedLease(fileSystem, staged, renewed)
    return Option.some({ renewed, stoodUntil: Date.parse(ours.value.expiresAt) })
  })

/**
 * Puts a staged renewal in place, and answers with how long the lease now stands for.
 *
 * One rename, and then the one question the rename cannot answer for itself: the record was
 * standing when it was read, but writing it took time of its own, and a write that landed after the
 * record it renewed had expired is one cleanup may already have acted on. Rejecting it is not
 * enough — the rename has already put a record back at a name cleanup may have emptied on its way
 * to removing the workspace — so it is taken away again, and only when it is still exactly what
 * this write left, so that a claim published in the meantime is put back rather than removed.
 */
const publishRenewal = (
  fileSystem: FileSystem.FileSystem,
  paths: RunWorkspacePaths,
  staged: string,
  prepared: StagedRenewal,
): Effect.Effect<Option.Option<number>, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    yield* publishStagedLease(fileSystem, staged, paths.leasePath)
    if ((yield* currentInstant).getTime() < prepared.stoodUntil) {
      return Option.some(Date.parse(prepared.renewed.expiresAt))
    }
    yield* withdrawLease(fileSystem, paths, prepared.renewed)
    return Option.none<number>()
  })

/**
 * One saying of a lease: interruptible up to the rename that publishes it, indivisible from there.
 *
 * Reading the record and staging its replacement can take as long as a slow or unreachable
 * filesystem takes, and a run being cancelled must not have to wait all of that out — nothing has
 * changed yet, so there is nothing to be caught halfway through. From the rename onwards there is:
 * a record that stands longer than the caller has been told it does is a lease this run would go on
 * to under-report, so publishing it and recording it are one step.
 */
const sayLease = (
  fileSystem: FileSystem.FileSystem,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  owner: WorkspaceOwner,
  now: Date,
  restore: <Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ) => Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Option.Option<number>, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    const staged = stagedLeasePath(paths.stagingPath)
    const prepared = yield* restore(stageRenewal(fileSystem, paths, run, owner, now, staged)).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : discardStagedLease(fileSystem, staged),
      ),
    )
    return yield* Option.match(prepared, {
      onNone: () => Effect.succeed(Option.none<number>()),
      onSome: (ready) =>
        publishRenewal(fileSystem, paths, staged, ready).pipe(
          Effect.ensuring(discardStagedLease(fileSystem, staged)),
        ),
    })
  })

const leaseLost = (paths: RunWorkspacePaths): WorkspaceError =>
  new WorkspaceError({
    category: 'lease_conflict',
    message: `workspace lease is no longer held by this run: ${paths.leasePath}`,
  })

/**
 * One renewal: says the lease again, and records how long it now stands for.
 *
 * A filesystem that would not answer is not by itself a lease lost — the record it could not write
 * is still standing for the rest of its window, and the next renewal may well land — but a run that
 * has not managed to say its lease again by the time that window runs out has lost it all the same,
 * because that is the moment another host is free to take it. Failing is how that reaches the run.
 */
const sayLeaseAgain = (
  fileSystem: FileSystem.FileSystem,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  owner: WorkspaceOwner,
  standing: Ref.Ref<number>,
): Effect.Effect<void, WorkspaceError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const until = yield* Ref.get(standing)
      const now = yield* currentInstant
      const said = yield* Effect.either(sayLease(fileSystem, paths, run, owner, now, restore))
      if (Either.isLeft(said)) {
        // The clock is read again rather than reused: an attempt that blocked on the filesystem
        // and then failed may itself have taken the rest of the window this run was standing on.
        const failedAt = yield* currentInstant
        return yield* failedAt.getTime() < until ? Effect.void : Effect.fail(leaseLost(paths))
      }
      return yield* Option.match(said.right, {
        onNone: () => Effect.fail(leaseLost(paths)),
        onSome: (stands) => Ref.set(standing, stands),
      })
    }),
  )

/**
 * Says it again on every interval, for as long as the run holds the lease — and fails when it no
 * longer does, which is what stops a run working on in a directory that is no longer its own.
 *
 * What the run carries between renewals is how long it knows the lease stands for, so that renewals
 * which never land are not mistaken for a lease that never expires. The caller holds that, not this
 * loop: a run's renewal is stopped and started again as it moves from provisioning to its own work,
 * and what the earlier renewals bought is still bought.
 */
export const renewLease = (
  fileSystem: FileSystem.FileSystem,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  owner: WorkspaceOwner,
  intervalMs: number,
  standing: Ref.Ref<number>,
): Effect.Effect<never, WorkspaceError> =>
  Effect.forever(Effect.delay(sayLeaseAgain(fileSystem, paths, run, owner, standing), intervalMs))

/**
 * The first saying of a lease, as soon as its claim is published — and it has to land.
 *
 * The published record carries the stamp of the file it was linked from, which is as old as
 * whatever happened between writing that file and linking it, and a second host reads that stamp
 * rather than this one's word for it. So the run says the lease before it builds anything on the
 * claim, and unlike a renewal this one tolerates nothing: a claim that cannot be said again is a
 * claim to give up, not to provision under while the record sits at a stamp nobody refreshed.
 */
export const sayClaimStands = (
  fileSystem: FileSystem.FileSystem,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  owner: WorkspaceOwner,
  standing: Ref.Ref<number>,
): Effect.Effect<void, WorkspaceError | PlatformError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const now = yield* currentInstant
      const said = yield* sayLease(fileSystem, paths, run, owner, now, restore)
      return yield* Option.match(said, {
        onNone: () => Effect.fail(leaseLost(paths)),
        onSome: (stands) => Ref.set(standing, stands),
      })
    }),
  )
