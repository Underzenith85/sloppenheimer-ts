import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { randomUUID } from 'node:crypto'
import { Effect, Option } from 'effect'

import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import {
  decodeLease,
  encodeLease,
  leaseIsClaimed,
  type WorkspaceLeaseRecord,
  type WorkspaceOwner,
} from '@sloppenheimer/core/domain/workspace-lease.js'

/**
 * The host half of the workspace lease: who this process is, whether a lease another process wrote
 * still has an owner, and reading and writing the record itself. What a record means is decided in
 * `domain/workspace-lease.ts`.
 */

/**
 * This host process, for as long as it runs. A lease naming it is this process's own, whatever the
 * operating system later does with the process id — which is why the identity is generated here
 * rather than taken from the pid alone. It is a module constant, so a workflow reload that rebuilds
 * the workspace manager keeps the same owner and still recognizes the leases it already holds.
 */
export const hostOwner: WorkspaceOwner = {
  hostId: randomUUID(),
  processId: process.pid,
}

/**
 * Whether the process that wrote a foreign lease is still running.
 *
 * Signal 0 performs the permission and existence checks without delivering anything. `EPERM` means
 * the process exists and belongs to another user, which is still a live owner. Any other refusal is
 * reported as live too: cleanup that cannot establish an owner is gone must not remove its
 * workspace.
 */
export const ownerIsRunning = (owner: WorkspaceOwner): boolean => {
  try {
    process.kill(owner.processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Whether a lease record still belongs to a running owner, as this host sees it. */
export const leaseIsLive = (lease: WorkspaceLeaseRecord): boolean =>
  leaseIsClaimed(lease, hostOwner.hostId, ownerIsRunning(lease.owner))

/**
 * Written to a sibling temporary file and renamed over the record, the way the handoff store is.
 * A host terminated mid-write would otherwise leave an empty or half-written lease, and a lease
 * that cannot be read is deliberately not treated as a workspace nobody owns: cleanup would then
 * refuse that issue's workspaces for good rather than recovering them.
 */
export const writeLease = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  lease: WorkspaceLeaseRecord,
): Effect.Effect<void, PlatformError> =>
  fileSystem
    .writeFileString(`${path}.tmp`, encodeLease(lease), { mode: 0o600 })
    .pipe(Effect.zipRight(fileSystem.rename(`${path}.tmp`, path)))

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
