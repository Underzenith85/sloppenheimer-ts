import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { randomUUID } from 'node:crypto'
import { readFileSync, readlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { Effect, Either, Option } from 'effect'

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
  type OwnerObservation,
  type WorkspaceLeaseRecord,
  type WorkspaceOwner,
} from '@sloppenheimer/core/domain/workspace-lease.js'

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
 * The machine, and the boot where the kernel names one.
 *
 * Every platform can answer this, which is what makes it the fallback where `/proc` is not there.
 * The boot half is deliberately the kernel's own identifier or nothing: a marker derived from
 * uptime would drift across the rounding boundary within one boot, and a host that concluded from
 * that drift that its neighbour had rebooted would take a live run's workspace. Without it, a
 * machine simply keeps probing process ids, which is what a host with no namespaces can do.
 */
const machineBoot = (): string => {
  try {
    return `${hostname()}/${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}`
  } catch {
    return hostname()
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
  boot: machineBoot(),
}

/**
 * Whether an owner's process ids are this host's to read: the same process namespace, where both
 * sides can name one, and otherwise the same machine and boot, where process ids are not namespaced
 * at all.
 */
const sharesProcessIds = (owner: WorkspaceOwner): boolean =>
  owner.namespace === null || hostOwner.namespace === null
    ? owner.boot === hostOwner.boot
    : owner.namespace === hostOwner.namespace

/**
 * What this host can see of a lease's owner now.
 *
 * An owner whose process ids are not this host's to read — another container's namespace, or
 * another machine — is unobservable, and is left alone rather than probed against whatever process
 * happens to carry its id here. An owner recorded under an earlier boot of this machine is the one
 * case that needs no probe at all: nothing survives a reboot.
 *
 * Otherwise, signal 0 performs the permission and existence checks without delivering anything.
 * `EPERM` means the process exists and belongs to another user, which is still a running owner. Any
 * other refusal is reported as running too: a cleanup that cannot establish an owner is gone must
 * not remove its workspace. A running process is reported with its own start marker, so a process
 * id the kernel handed to a successor is not mistaken for the process that recorded it.
 */
export const observeOwner = (owner: WorkspaceOwner): OwnerObservation => {
  if (!sharesProcessIds(owner)) {
    return owner.boot.split('/')[0] === hostOwner.boot.split('/')[0] &&
      owner.boot !== hostOwner.boot
      ? { _tag: 'Gone' }
      : { _tag: 'Unobservable' }
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

/** Whether a lease record still belongs to a running owner, as this host sees it. */
export const leaseIsLive = (lease: WorkspaceLeaseRecord): boolean =>
  leaseIsClaimed(lease, hostOwner.hostId, observeOwner(lease.owner))

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
