import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { randomUUID } from 'node:crypto'
import { readFileSync, readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Effect, Either, Option, Ref } from 'effect'

import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import { isSymbolicLink, realDirectoryExists } from './filesystem.js'
import {
  rejectWorkspace,
  sameIdentity,
  type DirectoryIdentity,
  type RunWorkspacePaths,
} from '@sloppenheimer/core/domain/workspace-containment.js'
import {
  decodeLease,
  encodeLease,
  leaseIsClaimed,
  leaseIsOurs,
  renewedLease,
  type OwnerObservation,
  type WorkspaceLeaseRecord,
  type WorkspaceOwner,
  type WorkspaceRun,
} from '@sloppenheimer/core/domain/workspace-lease.js'
import { currentInstant } from '@sloppenheimer/core/support/clock.js'

/**
 * The host half of the workspace lease: who this process is, whether a lease another process wrote
 * still has an owner, and reading and writing the record itself. What a record means is decided in
 * `domain/workspace-lease.ts`.
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

/** Whether a lease record still belongs to a running owner, as this host sees it now. */
export const leaseIsLive = (lease: WorkspaceLeaseRecord, now: Date): boolean =>
  leaseIsClaimed(lease, hostOwner.hostId, observeOwner(lease.owner), now)

/**
 * Stages a lease record for publication and hands the caller the path it was written to.
 *
 * The file is named for this write alone, so two writes to one lease path — a duplicate dispatch of
 * one run identity — cannot truncate each other's record. It is staged outside the issue directory,
 * because cleanup reads that directory as run workspaces and their leases and would take a
 * half-written record for one of them.
 */
/**
 * Writes a record where nothing yet refers to it, and hands back the path it went to.
 *
 * The name is this write's alone, so two writes to one lease path — a duplicate dispatch of one run
 * identity — cannot truncate each other's record. It is staged outside the issue directory, because
 * cleanup reads that directory as run workspaces and their leases and would take a half-written
 * record for one of them. The caller names the file first so that an interruption mid-write leaves
 * a path it can still take away.
 */
export const stagedLeasePath = (stagingPath: string): string =>
  join(stagingPath, `${randomUUID()}.lease`)

export const writeStagedLease = (
  fileSystem: FileSystem.FileSystem,
  staged: string,
  lease: WorkspaceLeaseRecord,
): Effect.Effect<void, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    const stagingPath = dirname(staged)
    // A staging directory that is a symbolic link would put every record it holds outside the
    // configured root — where the sweep below would then be deleting somebody else's files.
    if (!(yield* realDirectoryExists(fileSystem, stagingPath))) {
      yield* fileSystem.makeDirectory(stagingPath, { recursive: true })
    }
    yield* fileSystem.writeFileString(staged, encodeLease(lease), { mode: 0o600 })
  })

/** Takes a staged record away, whether it was published or abandoned. */
export const discardStagedLease = (
  fileSystem: FileSystem.FileSystem,
  staged: string,
): Effect.Effect<void> => Effect.ignore(fileSystem.remove(staged, { force: true }))

/**
 * Publishes a staged record under a name that must not already exist, which is what claims a run's
 * workspace.
 *
 * `link` is atomic and refuses a name that already exists, so the claim and the whole record appear
 * in one step — which is why this, and not the writing that precedes it, is the part a caller masks
 * against interruption. The run directory is created only afterwards, so cleanup elsewhere can
 * never come across a workspace that has no lease and take it for one nobody owns.
 */
export const publishClaimedLease = (
  fileSystem: FileSystem.FileSystem,
  staged: string,
  leasePath: string,
): Effect.Effect<void, PlatformError> =>
  fileSystem.link(staged, leasePath).pipe(Effect.ensuring(discardStagedLease(fileSystem, staged)))

/** What the staging directory was when the sweep verified it, so a later step can say it still is. */
const stagingIdentity = (
  fileSystem: FileSystem.FileSystem,
  stagingPath: string,
): Effect.Effect<DirectoryIdentity, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    if (yield* isSymbolicLink(fileSystem, stagingPath)) {
      return yield* Effect.fail(rejectWorkspace(`lease staging path is a link: ${stagingPath}`))
    }
    const info = yield* fileSystem.stat(stagingPath)
    if (info.type !== 'Directory') {
      return yield* Effect.fail(
        rejectWorkspace(`lease staging path is not a directory: ${stagingPath}`),
      )
    }
    return yield* Option.match(info.ino, {
      onNone: () =>
        Effect.fail(rejectWorkspace(`lease staging directory has no identity: ${stagingPath}`)),
      onSome: (inode) => Effect.succeed({ deviceId: info.dev, inode }),
    })
  })

/** The shape this module gives a staged record: a UUID and the suffix, and nothing else. */
const stagedRecordName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lease$/u

/**
 * Whether one entry is an abandoned staged record — and the last word on whether the sweep may
 * unlink it.
 *
 * Node offers no `unlinkat`, so the removal that follows resolves a pathname the sweep cannot hold
 * still. What it can do is refuse to remove anything that is not demonstrably its own: the name has
 * this module's shape, the entry is a plain file rather than a link or a directory, the contents
 * decode as a lease record, and it is older than any writer could be. A file reached through a
 * substituted path is a file the sweep does not recognize, and leaves alone.
 */
const isAbandonedRecord = (
  fileSystem: FileSystem.FileSystem,
  stagingPath: string,
  entry: string,
  now: Date,
  lifetimeMs: number,
): Effect.Effect<boolean, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    if (!stagedRecordName.test(entry)) {
      return false
    }
    const staged = join(stagingPath, entry)
    if (yield* isSymbolicLink(fileSystem, staged)) {
      return false
    }
    const info = yield* fileSystem.stat(staged)
    const abandoned =
      info.type === 'File' &&
      Option.exists(info.mtime, (modified) => now.getTime() - modified.getTime() > lifetimeMs)
    if (!abandoned) {
      return false
    }
    const document = yield* fileSystem.readFileString(staged, 'utf8')
    return Either.isRight(decodeLease(staged, document))
  })

/**
 * Takes away staged records no writer can still be holding.
 *
 * Staging is one write, so a record older than the lifetime belongs to a host that was killed
 * between writing it and publishing it. Nothing refers to such a file, but without this it would
 * stay under the staging directory for good, one per crash.
 *
 * The sweep deletes, so it does not trust the path it was given. It holds the directory open for
 * the whole pass, which pins the inode so a directory removed and recreated under that name cannot
 * be followed, and re-confirms the device and inode before every removal, the way a verified
 * workspace is re-confirmed at each boundary. Node offers no `unlinkat`, so that last instant
 * cannot be closed by identity alone — which is why `isAbandonedRecord` has the final word, and
 * unlinks nothing that is not a lease record this module wrote.
 */
export const pruneStagedLeases = (
  fileSystem: FileSystem.FileSystem,
  stagingPath: string,
  now: Date,
  lifetimeMs: number,
): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const verified = yield* stagingIdentity(fileSystem, stagingPath)
      const handle = yield* fileSystem.open(stagingPath, { flag: 'r' })
      const held = yield* handle.stat
      // Holding the directory open keeps its inode allocated, so one removed and recreated under
      // this name cannot be swept in its place — provided the handle is the directory verified.
      const pinned = Option.exists(held.ino, (inode) =>
        sameIdentity(verified, { deviceId: held.dev, inode }),
      )
      if (!pinned) {
        return
      }
      for (const entry of yield* fileSystem.readDirectory(stagingPath)) {
        const current = yield* stagingIdentity(fileSystem, stagingPath)
        if (!sameIdentity(verified, current)) {
          return
        }
        if (yield* isAbandonedRecord(fileSystem, stagingPath, entry, now, lifetimeMs)) {
          yield* discardStagedLease(fileSystem, join(stagingPath, entry))
        }
      }
    }),
  ).pipe(Effect.ignore)

/**
 * Replaces a record this run already owns. Staged and renamed over the lease, the way the handoff
 * store writes: a host terminated mid-write would otherwise leave an empty or half-written lease,
 * and a lease that cannot be read is deliberately not treated as a workspace nobody owns.
 */
export const writeLease = (
  fileSystem: FileSystem.FileSystem,
  paths: Pick<RunWorkspacePaths, 'leasePath' | 'stagingPath'>,
  lease: WorkspaceLeaseRecord,
): Effect.Effect<void, WorkspaceError | PlatformError> =>
  Effect.suspend(() => {
    const staged = stagedLeasePath(paths.stagingPath)
    return writeStagedLease(fileSystem, staged, lease).pipe(
      Effect.zipRight(fileSystem.rename(staged, paths.leasePath)),
      Effect.ensuring(discardStagedLease(fileSystem, staged)),
    )
  })

/**
 * Reads the lease beside a run workspace. A lease that is not there is `none` — a run directory
 * without one is an artifact of a host that died between the two writes, and belongs to nobody. A
 * lease that is there and cannot be read is a failure, because "unreadable" must never be treated
 * as "free".
 */
export const readLease = (
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<Option.Option<WorkspaceLeaseRecord>, WorkspaceError> =>
  fileSystem.readFileString(path, 'utf8').pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (error) => error._tag === 'SystemError' && error.reason === 'NotFound',
      () => Effect.succeed(Option.none<string>()),
    ),
    Effect.mapError(
      (error) =>
        new WorkspaceError({
          category: 'inspect_failed',
          message: `workspace lease could not be read: ${path}`,
          cause: error,
        }),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<WorkspaceLeaseRecord>()),
        onSome: (document) => Effect.map(decodeLease(path, document), Option.some),
      }),
    ),
  )

/** A lease record cleanup has moved aside, and where it moved it to. */
export type TakenLease = Readonly<{ lease: WorkspaceLeaseRecord; path: string }>

/**
 * Takes a lease record out of the issue directory and hands back what it actually took.
 *
 * Deciding that a workspace is free and then removing it are two steps, and between them the run
 * that holds it may say its lease still stands — after which the removal would be running against a
 * record that no longer says what it was decided on. So the record is moved aside first, in one
 * rename, which is atomic: what comes back is what was there rather than what the caller read a
 * moment ago, and once it is gone there is no record at that name for a renewal to find. A caller
 * that turns out to have taken a lease that still stands puts it back and leaves the workspace be.
 */
export const takeLease = (
  fileSystem: FileSystem.FileSystem,
  leasePath: string,
  stagingPath: string,
): Effect.Effect<Option.Option<TakenLease>, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    if (!(yield* realDirectoryExists(fileSystem, stagingPath))) {
      yield* fileSystem.makeDirectory(stagingPath, { recursive: true })
    }
    const taken = stagedLeasePath(stagingPath)
    const moved = yield* fileSystem.rename(leasePath, taken).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error._tag === 'SystemError' && error.reason === 'NotFound',
        () => Effect.succeed(false),
      ),
    )
    if (!moved) {
      return Option.none<TakenLease>()
    }
    // Whatever was taken is the caller's to account for, so a record that cannot be read goes back
    // where it came from rather than staying in staging under a name nothing refers to.
    const record = yield* readLease(fileSystem, taken).pipe(
      Effect.tapError(() => Effect.ignore(fileSystem.rename(taken, leasePath))),
    )
    return Option.map(record, (lease) => ({ lease, path: taken }))
  })

/** Puts a taken record back, for a run that said its lease still stands while cleanup decided. */
export const returnLease = (
  fileSystem: FileSystem.FileSystem,
  taken: TakenLease,
  leasePath: string,
): Effect.Effect<void, PlatformError> => fileSystem.rename(taken.path, leasePath)

/**
 * Says the lease again, answering with how long it now stands — or with nothing, when the record is
 * no longer this run's to say.
 */
const saidAgain = (
  fileSystem: FileSystem.FileSystem,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  owner: WorkspaceOwner,
  now: Date,
): Effect.Effect<Option.Option<number>, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    const existing = yield* readLease(fileSystem, paths.leasePath)
    const ours = Option.filter(existing, (lease) =>
      leaseIsOurs(lease, run, paths.runKey, owner.hostId, now),
    )
    if (Option.isNone(ours)) {
      return Option.none<number>()
    }
    const renewed = renewedLease(ours.value, now)
    yield* writeLease(fileSystem, paths, renewed)
    // The record was standing when it was read, but writing it took time of its own: a write that
    // landed after the record it renewed had expired is one cleanup may already have acted on.
    return (yield* currentInstant).getTime() < Date.parse(ours.value.expiresAt)
      ? Option.some(Date.parse(renewed.expiresAt))
      : Option.none<number>()
  })

const leaseLost = (paths: RunWorkspacePaths): WorkspaceError =>
  new WorkspaceError({
    category: 'lease_conflict',
    message: `workspace lease is no longer held by this run: ${paths.leasePath}`,
  })

/**
 * Says once that a lease still stands, and answers with how long this run knows it stands for.
 *
 * A host that cannot observe this one's process has nothing else to go on: renewal is what tells it
 * the run is still there. A filesystem that would not answer is not by itself a lease lost — the
 * record it could not write is still standing for the rest of its window, and the next renewal may
 * well land — but a run that has not managed to say its lease again by the time that window runs
 * out has lost it all the same, because that is the moment another host is free to take it.
 */
const sayLeaseStands = (
  fileSystem: FileSystem.FileSystem,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  owner: WorkspaceOwner,
  standingUntil: number,
): Effect.Effect<number, WorkspaceError> =>
  Effect.gen(function* () {
    const now = yield* currentInstant
    const said = yield* Effect.either(saidAgain(fileSystem, paths, run, owner, now))
    if (Either.isRight(said)) {
      return yield* Option.match(said.right, {
        onNone: () => Effect.fail(leaseLost(paths)),
        onSome: (until) => Effect.succeed(until),
      })
    }
    return now.getTime() < standingUntil ? standingUntil : yield* Effect.fail(leaseLost(paths))
  })

/**
 * Says a lease still stands, for as long as the run holds it — and fails when it no longer does.
 *
 * The failure is the point: a lease this run has lost is one another host may already be taking the
 * workspace back on, so the run that lost it stops rather than working on in a directory that is no
 * longer its own. What it carries between renewals is how long it knows the lease stands for, so
 * that renewals which never land are not mistaken for a lease that never expires.
 */
export const renewLease = (
  fileSystem: FileSystem.FileSystem,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  owner: WorkspaceOwner,
  intervalMs: number,
  standingUntil: number,
): Effect.Effect<never, WorkspaceError> =>
  Effect.gen(function* () {
    const standing = yield* Ref.make(standingUntil)
    return yield* Effect.forever(
      Ref.get(standing).pipe(
        Effect.flatMap((until) => sayLeaseStands(fileSystem, paths, run, owner, until)),
        Effect.flatMap((until) => Ref.set(standing, until)),
        Effect.delay(intervalMs),
      ),
    )
  })
