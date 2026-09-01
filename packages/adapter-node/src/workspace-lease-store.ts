import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Effect, Either, Option } from 'effect'

import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import { directoryIdentity, isSymbolicLink, realDirectoryExists } from './filesystem.js'
import { stagedLeaseIsLive } from './workspace-lease.js'
import {
  sameIdentity,
  type RunWorkspacePaths,
} from '@sloppenheimer/core/domain/workspace-containment.js'
import {
  decodeLease,
  encodeLease,
  type WorkspaceLeaseRecord,
} from '@sloppenheimer/core/domain/workspace-lease.js'

/**
 * Where a lease record lives and how it gets there: staged where nothing refers to it, published by
 * one atomic link, replaced by one atomic rename, taken aside by another, and swept when a writer
 * left one behind. Every step here is about the file. What a record means is decided in
 * `domain/workspace-lease.ts`, and who may act on one in `workspace-lease.ts`.
 */

/**
 * Names a record's staging file, where nothing yet refers to it.
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

/** The shape this module gives a staged record: a UUID and the suffix, and nothing else. */
const stagedRecordName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lease$/u

/**
 * Whether one entry is an abandoned staged record — and the last word on whether the sweep may
 * unlink it.
 *
 * A staged record names the host that wrote it, so the sweep asks the same question cleanup asks of
 * a published one: is that host still there? A record whose writer is gone was left by a host
 * killed between writing it and publishing it, and nothing refers to it. One whose writer is
 * running — this process's own, seconds old — is in flight. One whose writer this host cannot place
 * is left alone, like every other record of an owner it cannot see.
 *
 * Node offers no `unlinkat`, so the removal that follows resolves a pathname the sweep cannot hold
 * still. What it can do is refuse to remove anything that is not demonstrably its own: the name has
 * this module's shape, the entry is a plain file rather than a link or a directory, and the
 * contents decode as a lease record. A file reached through a substituted path is a file the sweep
 * does not recognize, and leaves alone.
 */
const isAbandonedRecord = (
  fileSystem: FileSystem.FileSystem,
  stagingPath: string,
  entry: string,
): Effect.Effect<boolean, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    if (!stagedRecordName.test(entry)) {
      return false
    }
    const staged = join(stagingPath, entry)
    if (yield* isSymbolicLink(fileSystem, staged)) {
      return false
    }
    if ((yield* fileSystem.stat(staged)).type !== 'File') {
      return false
    }
    const document = yield* fileSystem.readFileString(staged, 'utf8')
    return Either.match(decodeLease(staged, document), {
      onLeft: () => false,
      onRight: (record) => !stagedLeaseIsLive(record),
    })
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
): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const verified = yield* directoryIdentity(fileSystem, stagingPath, 'lease staging path')
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
        const current = yield* directoryIdentity(fileSystem, stagingPath, 'lease staging path')
        if (!sameIdentity(verified, current)) {
          return
        }
        if (yield* isAbandonedRecord(fileSystem, stagingPath, entry)) {
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

/**
 * Puts a taken record back where it came from, and answers whether it went.
 *
 * The name was vacated to take it, so it may have been claimed since — by an acquisition that found
 * it free, published its own record and started work. Putting this one back with a rename would
 * replace that claim and leave two runs holding one workspace, so it goes back the way a claim is
 * published: one `link`, which refuses a name that already exists. A record that cannot go back is
 * discarded, because the workspace now belongs to whoever took the name.
 */
export const returnLease = (
  fileSystem: FileSystem.FileSystem,
  taken: TakenLease,
  leasePath: string,
): Effect.Effect<boolean, PlatformError> =>
  fileSystem.link(taken.path, leasePath).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error._tag === 'SystemError' && error.reason === 'AlreadyExists',
      () => Effect.succeed(false),
    ),
    Effect.ensuring(discardStagedLease(fileSystem, taken.path)),
  )
