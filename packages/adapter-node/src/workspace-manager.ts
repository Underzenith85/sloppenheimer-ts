import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Effect, Option } from 'effect'

import type { HooksConfig } from '@sloppenheimer/core/config/workflow.js'
import type { IssueIdentifier, Workspace } from '@sloppenheimer/core/domain/domain.js'
import {
  containedRunWorkspacePath,
  containedWorkspacePath,
  isLeaseEntry,
  leasePathFor,
  runWorkspaceKey,
  workspaceKey,
  type RunWorkspacePaths,
} from '@sloppenheimer/core/domain/workspace-containment.js'
import {
  heldLease,
  retainedLease,
  type WorkspaceOwner,
  type WorkspaceRelease,
  type WorkspaceRun,
} from '@sloppenheimer/core/domain/workspace-lease.js'
import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import type { LeasedWorkspace, WorkspaceManagerPort } from '@sloppenheimer/core/ports/workspace.js'
import { currentInstant } from '@sloppenheimer/core/support/clock.js'
import { logWarning } from '@sloppenheimer/core/support/logging.js'
import { isSymbolicLink } from './filesystem.js'
import { hostOwner, leaseIsLive, readLease, writeLease } from './workspace-lease.js'
import { runHook } from './workspace-hooks.js'

/**
 * The Node implementation of `WorkspaceManagerPort`: the per-run directory lifecycle, with the
 * containment rules taken from `domain/workspace-containment.ts`, the lease rules from
 * `domain/workspace-lease.ts`, and the hooks run by `workspace-hooks.ts`.
 *
 * An issue owns a directory under the configured root, and every dispatched run owns a directory
 * under that, leased to it for as long as it runs. Two runs of one issue therefore share no
 * worktree, no index and no ref store, and a run that ends without publishing leaves its directory
 * behind as a lease record naming the issue, the run and the host that produced it.
 */

const notADirectory = (path: string): WorkspaceError =>
  new WorkspaceError({
    category: 'invalid_path',
    message: `workspace exists and is not a directory: ${path}`,
  })

/**
 * Reports whether a usable workspace directory is present. A path that exists but is not a real
 * directory — a file, or a symbolic link pointing elsewhere — is rejected rather than treated as a
 * workspace, so cleanup can never follow a substituted path.
 *
 * The absent case is named by the platform error's `reason` rather than by matching an `ENOENT`
 * code on an unknown cause; every other platform failure is left for the calling operation to
 * report under its own category.
 */
const workspaceDirectoryExists = (
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<boolean, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    if (yield* isSymbolicLink(fileSystem, path)) {
      return yield* Effect.fail(notADirectory(path))
    }
    const info = yield* fileSystem.stat(path)
    if (info.type !== 'Directory') {
      return yield* Effect.fail(notADirectory(path))
    }
    return true
  }).pipe(
    Effect.catchIf(
      (error) => error._tag === 'SystemError' && error.reason === 'NotFound',
      () => Effect.succeed(false),
    ),
  )

/**
 * Claims one run's directory. The directory is created without `recursive`, so creating it is the
 * exclusive claim itself: the kernel refuses the second creation of a name that already exists, and
 * a second dispatch of the same run identity therefore fails here rather than entering a live
 * workspace. The lease record beside it says who the owner is once the claim has been won.
 */
const claimRunDirectory = (
  fileSystem: FileSystem.FileSystem,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  owner: WorkspaceOwner,
): Effect.Effect<void, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    // The issue directory is only ever a container for run directories, so an existing one is
    // reused — once it has been confirmed to be a real directory rather than a substituted path.
    if (!(yield* workspaceDirectoryExists(fileSystem, paths.issuePath))) {
      yield* fileSystem.makeDirectory(paths.issuePath, { recursive: true })
    }
    yield* fileSystem.makeDirectory(paths.runPath).pipe(
      Effect.catchIf(
        (error) => error._tag === 'SystemError' && error.reason === 'AlreadyExists',
        (error) =>
          Effect.fail(
            new WorkspaceError({
              category: 'lease_conflict',
              message: `workspace is already allocated to another run: ${paths.runPath}`,
              cause: error,
            }),
          ),
      ),
    )
    const acquiredAt = yield* currentInstant
    yield* writeLease(fileSystem, paths.leasePath, heldLease(run, paths.runKey, owner, acquiredAt))
  })

/**
 * The one shape every operation reports through: a containment or lease rejection is already the
 * answer and travels unchanged, and anything else becomes this operation's own category.
 */
const workspaceFailure =
  (category: 'create_failed' | 'inspect_failed' | 'remove_failed', message: string) =>
  (cause: WorkspaceError | PlatformError): WorkspaceError =>
    cause instanceof WorkspaceError ? cause : new WorkspaceError({ category, message, cause })

/** Applies that shape to an operation's error channel. */
const reportedAs =
  (category: 'create_failed' | 'inspect_failed' | 'remove_failed', message: string) =>
  <Value>(
    effect: Effect.Effect<Value, WorkspaceError | PlatformError>,
  ): Effect.Effect<Value, WorkspaceError> =>
    Effect.mapError(effect, workspaceFailure(category, message))

/** The run keys an issue directory holds, from its run directories and its lease records alike. */
const runKeysIn = (entries: readonly string[]): readonly string[] => [
  ...new Set(
    entries.map((entry) => (isLeaseEntry(entry) ? entry.slice(0, -'.lease'.length) : entry)),
  ),
]

/** Removes one run's directory and the lease record beside it, hooks first. */
const removeRunWorkspace = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  runPath: string,
): Effect.Effect<void, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    if (hooks.beforeRemove !== null && (yield* workspaceDirectoryExists(fileSystem, runPath))) {
      yield* runHook('before_remove', hooks.beforeRemove, runPath, hooks.timeoutMs).pipe(
        Effect.catchAll(() => Effect.void),
      )
    }
    yield* fileSystem.remove(runPath, { force: true, recursive: true })
    yield* fileSystem.remove(leasePathFor(runPath), { force: true })
  })

/**
 * Every run workspace of one issue that no live owner holds, removed; the run keys that were left
 * alone are returned, because an issue directory still holding one of them cannot go with them.
 */
const removeFreeRunWorkspaces = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  issuePath: string,
): Effect.Effect<readonly string[], WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(issuePath)
    const held: string[] = []
    for (const key of runKeysIn(entries)) {
      const runPath = yield* containedWorkspacePath(issuePath, key)
      const lease = yield* readLease(fileSystem, leasePathFor(runPath))
      if (Option.exists(lease, leaseIsLive)) {
        held.push(key)
        continue
      }
      yield* removeRunWorkspace(fileSystem, hooks, runPath)
    }
    return held
  })

/** Reports a failure that a release has no one left to report it to. */
const warnRelease = (path: string, error: WorkspaceError): Effect.Effect<void> =>
  logWarning('workspace lease release failed', {
    action: 'workspace_release',
    outcome: 'failed',
    path,
    error: error.message,
  })

/**
 * Allocates and leases one run's workspace. `after_create` is fatal: a workspace whose provisioning
 * hook failed is not usable. It runs for every run, because every run is given a directory that did
 * not exist before it.
 */
const acquireRunWorkspace = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  root: string,
  owner: WorkspaceOwner,
  run: WorkspaceRun,
): Effect.Effect<LeasedWorkspace, WorkspaceError> =>
  Effect.gen(function* () {
    const paths = yield* containedRunWorkspacePath(
      root,
      run.identifier,
      runWorkspaceKey(run.runId, owner.hostId),
    )
    yield* claimRunDirectory(fileSystem, paths, run, owner).pipe(
      reportedAs('create_failed', 'failed to create workspace'),
    )
    const workspace: Workspace = { path: paths.runPath, key: paths.runKey }
    if (hooks.afterCreate !== null) {
      yield* runHook('after_create', hooks.afterCreate, workspace.path, hooks.timeoutMs)
    }
    const leased: LeasedWorkspace = { run, workspace }
    return leased
  })

/** Discards a released workspace, or keeps it as the recovery artifact its lease names. */
const disposeOfWorkspace = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  owner: WorkspaceOwner,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  reason: string | null,
): Effect.Effect<void, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    if (reason === null) {
      yield* removeRunWorkspace(fileSystem, hooks, paths.runPath)
      // The issue directory itself stays. It is an empty container once its last run has gone, and
      // removing it here would race an acquisition that has just created its own run directory
      // inside it; cleanup takes it when the issue is finished with.
      return
    }
    const releasedAt = yield* currentInstant
    const existing = yield* readLease(fileSystem, paths.leasePath)
    const held = Option.getOrElse(existing, () => heldLease(run, paths.runKey, owner, releasedAt))
    yield* writeLease(fileSystem, paths.leasePath, retainedLease(held, reason, releasedAt))
  })

/** Releasing reports to nobody: the run it followed has already ended, so a failure is logged. */
const releaseRunWorkspace = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  root: string,
  owner: WorkspaceOwner,
  leased: LeasedWorkspace,
  release: WorkspaceRelease,
): Effect.Effect<void> =>
  containedRunWorkspacePath(root, leased.run.identifier, leased.workspace.key).pipe(
    Effect.flatMap((paths) =>
      disposeOfWorkspace(
        fileSystem,
        hooks,
        owner,
        paths,
        leased.run,
        release._tag === 'Completed' ? null : release.reason,
      ).pipe(reportedAs('remove_failed', 'failed to release workspace')),
    ),
    Effect.catchAll((error) => warnRelease(leased.workspace.path, error)),
  )

/** An issue's retained workspaces, and never one a live run still holds. */
const removeIssueWorkspaces = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  root: string,
  identifier: IssueIdentifier,
): Effect.Effect<void, WorkspaceError> =>
  Effect.gen(function* () {
    const issuePath = yield* containedWorkspacePath(root, workspaceKey(identifier))
    if (!(yield* workspaceDirectoryExists(fileSystem, issuePath))) {
      return
    }
    const held = yield* removeFreeRunWorkspaces(fileSystem, hooks, issuePath)
    if (held.length > 0) {
      yield* logWarning('leased workspaces kept during cleanup', {
        action: 'workspace_cleanup',
        outcome: 'skipped',
        path: issuePath,
        leased: held.length,
      })
      return
    }
    yield* fileSystem.remove(issuePath, { force: true, recursive: true })
  }).pipe(reportedAs('remove_failed', 'failed to remove workspace'))

/**
 * Whether the issue holds a workspace at all: an issue directory emptied by the last run to let go
 * of its own is nothing to clean up, and says so.
 */
const issueHoldsWorkspace = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  identifier: IssueIdentifier,
): Effect.Effect<boolean, WorkspaceError> =>
  Effect.gen(function* () {
    const path = yield* containedWorkspacePath(root, workspaceKey(identifier))
    if (!(yield* workspaceDirectoryExists(fileSystem, path))) {
      return false
    }
    return (yield* fileSystem.readDirectory(path)).length > 0
  }).pipe(reportedAs('inspect_failed', 'failed to inspect workspace'))

export const makeWorkspaceManager = (
  root: string,
  hooks: HooksConfig,
  owner: WorkspaceOwner = hostOwner,
): Effect.Effect<WorkspaceManagerPort, never, FileSystem.FileSystem> =>
  Effect.map(FileSystem.FileSystem, (fileSystem) => ({
    acquire: (run) => acquireRunWorkspace(fileSystem, hooks, root, owner, run),
    release: (leased, release) =>
      releaseRunWorkspace(fileSystem, hooks, root, owner, leased, release),
    exists: (identifier) => issueHoldsWorkspace(fileSystem, root, identifier),
    // `before_run` is fatal: the orchestrator retries the issue instead of launching an agent.
    beforeRun: (workspace) =>
      hooks.beforeRun === null
        ? Effect.void
        : runHook('before_run', hooks.beforeRun, workspace.path, hooks.timeoutMs),
    // `after_run` is best effort: the turn already happened.
    afterRun: (workspace) =>
      hooks.afterRun === null
        ? Effect.void
        : runHook('after_run', hooks.afterRun, workspace.path, hooks.timeoutMs).pipe(
            Effect.catchAll(() => Effect.void),
          ),
    remove: (identifier) => removeIssueWorkspaces(fileSystem, hooks, root, identifier),
  }))
