import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Effect, Option } from 'effect'

import type { HooksConfig } from '@sloppenheimer/core/config/workflow.js'
import type { IssueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import {
  containedWorkspacePath,
  isLeaseEntry,
  leasePathFor,
  leaseStagingPath,
  workspaceKey,
} from '@sloppenheimer/core/domain/workspace-containment.js'
import type { WorkspaceLeaseRecord } from '@sloppenheimer/core/domain/workspace-lease.js'
import type { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import { logWarning } from '@sloppenheimer/core/support/logging.js'
import { realDirectoryExists, removeDirectoryIfEmpty, reportedAs } from './filesystem.js'
import { leaseIsLive, leaseUnrenewedFor, storageInstant } from './workspace-lease.js'
import { discardStagedLease, readLease, returnLease, takeLease } from './workspace-lease-store.js'
import { runHook } from './workspace-hooks.js'

/**
 * Taking a workspace back: which of an issue's run workspaces no live run still holds, and the
 * removal of the ones that are free.
 *
 * Nothing here removes anything a lease still stands over. Deciding that and removing are two
 * steps, so the record is taken aside between them and the decision made again on what was actually
 * taken; a lease that turns out to still stand goes back where it was.
 */

/**
 * Whether a record is still held, given how long it has gone unwritten. An age this host could not
 * measure is not evidence that anything expired, so the lease is left where it is.
 */
const leaseStillHeld = (
  lease: WorkspaceLeaseRecord,
  unrenewedFor: Option.Option<number>,
): boolean =>
  Option.match(unrenewedFor, {
    onNone: () => true,
    onSome: (age) => leaseIsLive(lease, age),
  })

/** The run keys an issue directory holds, from its run directories and its lease records alike. */
const runKeysIn = (entries: readonly string[]): readonly string[] => [
  ...new Set(
    entries.map((entry) => (isLeaseEntry(entry) ? entry.slice(0, -'.lease'.length) : entry)),
  ),
]

/**
 * The operator's last look at a workspace before it goes. It is their own command, so nothing
 * bounds it, and its failures are logged rather than raised: the removal happens either way.
 *
 * A release runs this while its lease is still being renewed, which is why it is a step of its own:
 * a hook that outlasts the window its run's lease stands for must not leave that lease unsaid.
 */
export const runBeforeRemove = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  runPath: string,
): Effect.Effect<void, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    if (hooks.beforeRemove !== null && (yield* realDirectoryExists(fileSystem, runPath))) {
      yield* runHook('before_remove', hooks.beforeRemove, runPath, hooks.timeoutMs).pipe(
        Effect.catchAll(() => Effect.void),
      )
    }
  })

/** Takes away one run's directory and the lease record beside it, and nothing else. */
export const removeRunWorkspaceFiles = (
  fileSystem: FileSystem.FileSystem,
  runPath: string,
): Effect.Effect<void, PlatformError> =>
  Effect.gen(function* () {
    yield* fileSystem.remove(runPath, { force: true, recursive: true })
    yield* fileSystem.remove(leasePathFor(runPath), { force: true })
  })

/** Removes one run's directory and the lease record beside it, hook first. */
export const removeRunWorkspace = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  runPath: string,
): Effect.Effect<void, WorkspaceError | PlatformError> =>
  Effect.zipRight(
    runBeforeRemove(fileSystem, hooks, runPath),
    removeRunWorkspaceFiles(fileSystem, runPath),
  )

/**
 * Removes one run workspace that no live owner holds, unless taking its record shows otherwise.
 *
 * Reading a lease and removing what it names are two steps, and a `before_remove` hook stands
 * between them: an owner this host cannot observe could say its lease still stands in that time,
 * and the removal would then be taking a workspace back off a live run. So the record is taken out
 * of the way before anything destructive runs, and the removal proceeds only if what was taken is
 * still the record that was decided on. A lease that stands again goes back where it was, and the
 * run keeps its workspace.
 */
const removeFreeRunWorkspace = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  runPath: string,
  stagingPath: string,
  storageNow: Option.Option<number>,
): Effect.Effect<boolean, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    const leasePath = leasePathFor(runPath)
    const taken = yield* takeLease(fileSystem, leasePath, stagingPath)
    if (Option.isSome(taken)) {
      // The rename kept the record's own stamp, so what was taken is still dated by the last run
      // to say it — on the storage's clock, which is the one clock both hosts have.
      const unrenewed = yield* leaseUnrenewedFor(fileSystem, taken.value.path, storageNow)
      if (leaseStillHeld(taken.value.lease, unrenewed)) {
        yield* returnLease(fileSystem, taken.value, leasePath)
        return false
      }
    }
    yield* removeRunWorkspace(fileSystem, hooks, runPath)
    yield* Option.match(taken, {
      onNone: () => Effect.void,
      onSome: (record) => discardStagedLease(fileSystem, record.path),
    })
    return true
  })

/**
 * Every run workspace of one issue that no live owner holds, removed; the run keys that were left
 * alone are returned, because an issue directory still holding one of them cannot go with them.
 */
const removeFreeRunWorkspaces = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  issuePath: string,
  stagingPath: string,
): Effect.Effect<readonly string[], WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(issuePath)
    const storageNow = yield* storageInstant(fileSystem, stagingPath)
    const held: string[] = []
    for (const key of runKeysIn(entries)) {
      const runPath = yield* containedWorkspacePath(issuePath, key)
      const lease = yield* readLease(fileSystem, leasePathFor(runPath))
      // A lease that is plainly still held is never taken, even for a moment: the run holding it
      // reads its own record every renewal, and one it could not find would be one it had lost.
      if (Option.isSome(lease)) {
        const unrenewed = yield* leaseUnrenewedFor(fileSystem, leasePathFor(runPath), storageNow)
        if (leaseStillHeld(lease.value, unrenewed)) {
          held.push(key)
          continue
        }
      }
      if (!(yield* removeFreeRunWorkspace(fileSystem, hooks, runPath, stagingPath, storageNow))) {
        held.push(key)
      }
    }
    return held
  })

/** An issue's retained workspaces, and never one a live run still holds. */
export const removeIssueWorkspaces = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  root: string,
  identifier: IssueIdentifier,
): Effect.Effect<void, WorkspaceError> =>
  Effect.gen(function* () {
    const issuePath = yield* containedWorkspacePath(root, workspaceKey(identifier))
    if (!(yield* realDirectoryExists(fileSystem, issuePath))) {
      return
    }
    const held = yield* removeFreeRunWorkspaces(
      fileSystem,
      hooks,
      issuePath,
      leaseStagingPath(root),
    )
    if (held.length > 0) {
      yield* logWarning('leased workspaces kept during cleanup', {
        action: 'workspace_cleanup',
        outcome: 'skipped',
        path: issuePath,
        leased: held.length,
      })
      return
    }
    // Not a recursive removal: a run acquired while the scan was running would be swept up with
    // the container it had just been created in. `rmdir` refuses a directory that is no longer
    // empty, so a workspace that appeared during cleanup survives it.
    yield* removeDirectoryIfEmpty(issuePath)
  }).pipe(reportedAs('remove_failed', 'failed to remove workspace'))

/**
 * Whether the issue holds a workspace at all: an issue directory emptied by the last run to let go
 * of its own is nothing to clean up, and says so.
 */
export const issueHoldsWorkspace = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  identifier: IssueIdentifier,
): Effect.Effect<boolean, WorkspaceError> =>
  Effect.gen(function* () {
    const path = yield* containedWorkspacePath(root, workspaceKey(identifier))
    if (!(yield* realDirectoryExists(fileSystem, path))) {
      return false
    }
    return (yield* fileSystem.readDirectory(path)).length > 0
  }).pipe(reportedAs('inspect_failed', 'failed to inspect workspace'))
