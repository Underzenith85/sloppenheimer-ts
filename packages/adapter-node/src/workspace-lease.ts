import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { randomUUID } from 'node:crypto'
import { readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Effect, Option } from 'effect'

import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import type { RunWorkspacePaths } from '@sloppenheimer/core/domain/workspace-containment.js'
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
 * What this host can see of a lease's owner now.
 *
 * An owner whose process ids are not this host's to read — another namespace, or one neither side
 * could identify — is unobservable, and is left alone rather than probed against whatever process
 * happens to carry its id here.
 *
 * Otherwise, signal 0 performs the permission and existence checks without delivering anything.
 * `EPERM` means the process exists and belongs to another user, which is still a running owner. Any
 * other refusal is reported as running too: a cleanup that cannot establish an owner is gone must
 * not remove its workspace. A running process is reported with its own start marker, so a process
 * id the kernel handed to a successor is not mistaken for the process that recorded it.
 */
export const observeOwner = (owner: WorkspaceOwner): OwnerObservation => {
  if (
    owner.namespace === null ||
    hostOwner.namespace === null ||
    owner.namespace !== hostOwner.namespace
  ) {
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
const stageLease = (
  fileSystem: FileSystem.FileSystem,
  stagingPath: string,
  lease: WorkspaceLeaseRecord,
): Effect.Effect<string, PlatformError> =>
  Effect.suspend(() => {
    const staged = join(stagingPath, `${randomUUID()}.lease`)
    return fileSystem
      .makeDirectory(stagingPath, { recursive: true })
      .pipe(
        Effect.zipRight(fileSystem.writeFileString(staged, encodeLease(lease), { mode: 0o600 })),
        Effect.as(staged),
      )
  })

/** Publishes a staged record under `path`, and takes the staged copy away either way. */
const publishStaged = (
  fileSystem: FileSystem.FileSystem,
  staged: string,
  publish: (staged: string) => Effect.Effect<void, PlatformError>,
): Effect.Effect<void, PlatformError> =>
  publish(staged).pipe(Effect.ensuring(Effect.ignore(fileSystem.remove(staged, { force: true }))))

/**
 * Publishes a lease under a name that must not already exist, which is what claims a run's
 * workspace.
 *
 * The record is written to a sibling temporary file and hard-linked into place: `link` is atomic
 * and refuses a name that already exists, so the claim and the whole record appear in one step. The
 * run directory is created only afterwards, so cleanup elsewhere can never come across a workspace
 * that has no lease and take it for one nobody owns.
 */
export const claimLease = (
  fileSystem: FileSystem.FileSystem,
  paths: Pick<RunWorkspacePaths, 'leasePath' | 'stagingPath'>,
  lease: WorkspaceLeaseRecord,
): Effect.Effect<void, PlatformError> =>
  stageLease(fileSystem, paths.stagingPath, lease).pipe(
    Effect.flatMap((staged) =>
      publishStaged(fileSystem, staged, (from) => fileSystem.link(from, paths.leasePath)),
    ),
  )

export const writeLease = (
  fileSystem: FileSystem.FileSystem,
  paths: Pick<RunWorkspacePaths, 'leasePath' | 'stagingPath'>,
  lease: WorkspaceLeaseRecord,
): Effect.Effect<void, PlatformError> =>
  stageLease(fileSystem, paths.stagingPath, lease).pipe(
    Effect.flatMap((staged) =>
      publishStaged(fileSystem, staged, (from) => fileSystem.rename(from, paths.leasePath)),
    ),
  )

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
