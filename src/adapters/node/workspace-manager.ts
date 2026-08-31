import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Effect } from 'effect'

import type { HooksConfig } from '../../config/workflow.js'
import type { IssueIdentifier, Workspace } from '../../domain/domain.js'
import {
  containedTrashEntryPath,
  containedTrashRoot,
  containedWorkspacePath,
  workspaceKey,
} from '../../domain/workspace-containment.js'
import { WorkspaceError } from '../../errors.js'
import type { WorkspaceManagerPort } from '../../ports/workspace.js'
import { isSymbolicLink } from './filesystem.js'
import { runHook } from './workspace-hooks.js'

/**
 * The Node implementation of `WorkspaceManagerPort`: the per-issue directory lifecycle, with the
 * containment rules taken from `domain/workspace-containment.ts` and the hooks run by
 * `workspace-hooks.ts`.
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

const prepareWorkspace = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  identifier: IssueIdentifier,
): Effect.Effect<Workspace, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    const key = workspaceKey(identifier)
    const path = yield* containedWorkspacePath(root, key)
    yield* fileSystem.makeDirectory(root, { recursive: true })
    if (yield* workspaceDirectoryExists(fileSystem, path)) {
      return { path, key, createdNow: false }
    }
    yield* fileSystem.makeDirectory(path)
    return { path, key, createdNow: true }
  })

/**
 * Moves a workspace out of its canonical path and into the trash root, where deletion no longer
 * has to succeed for the path to be reusable.
 *
 * The rename is atomic and the trash root is a sibling inside the same root, so it is a link
 * operation on one filesystem rather than a copy: the moment it returns, the canonical path is free
 * for the next attempt, and any process still running in the old directory is writing somewhere
 * nothing will look at again.
 */
const retireWorkspace = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  key: string,
  path: string,
): Effect.Effect<void, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    const trashRoot = yield* containedTrashRoot(root)
    const entry = yield* containedTrashEntryPath(root, key, randomUUID())
    yield* fileSystem.makeDirectory(trashRoot, { recursive: true })
    yield* fileSystem.rename(path, entry)
  })

/**
 * Retires the workspace, falling back to deleting it where it stands.
 *
 * The fallback exists so that this can never be worse than the direct removal it replaces: a
 * filesystem that refuses the rename, or a trash root that cannot be created, still gets the
 * workspace deleted. The path has already passed containment either way, so every failure of the
 * retirement is answered the same way rather than being distinguished.
 */
const retireOrRemoveWorkspace = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  key: string,
  path: string,
): Effect.Effect<void, PlatformError> =>
  retireWorkspace(fileSystem, root, key, path).pipe(
    Effect.catchAll(() => fileSystem.remove(path, { force: true, recursive: true })),
  )

/**
 * Deletes everything in the trash root, and reports nothing.
 *
 * This is where retired workspaces are actually freed, so it runs on every removal — including one
 * that found no workspace, which is what clears entries stranded by a host that died between the
 * rename and the delete. Failure is deliberately invisible: a sweep that cannot finish costs disk
 * until the next removal, and never a caller that was only asking for a workspace to go away.
 */
const sweepTrash = (fileSystem: FileSystem.FileSystem, root: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const trashRoot = yield* containedTrashRoot(root)
    const entries = yield* fileSystem.readDirectory(trashRoot)
    yield* Effect.forEach(
      entries,
      (entry) =>
        fileSystem
          .remove(join(trashRoot, entry), { force: true, recursive: true })
          .pipe(Effect.ignore),
      { discard: true },
    )
  }).pipe(Effect.ignore)

/**
 * The one shape every operation reports through: a containment rejection is already the answer and
 * travels unchanged, and anything else becomes this operation's own category.
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

export const makeWorkspaceManager = (
  root: string,
  hooks: HooksConfig,
): Effect.Effect<WorkspaceManagerPort, never, FileSystem.FileSystem> =>
  Effect.map(FileSystem.FileSystem, (fileSystem) => ({
    // `after_create` is fatal: a workspace whose provisioning hook failed is not usable.
    create: (identifier) =>
      prepareWorkspace(fileSystem, root, identifier).pipe(
        reportedAs('create_failed', 'failed to create workspace'),
        Effect.flatMap((workspace) =>
          workspace.createdNow && hooks.afterCreate !== null
            ? runHook('after_create', hooks.afterCreate, workspace.path, hooks.timeoutMs).pipe(
                Effect.as(workspace),
              )
            : Effect.succeed(workspace),
        ),
      ),
    exists: (identifier) =>
      Effect.gen(function* () {
        const path = yield* containedWorkspacePath(root, workspaceKey(identifier))
        return yield* workspaceDirectoryExists(fileSystem, path)
      }).pipe(reportedAs('inspect_failed', 'failed to inspect workspace')),
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
    // `before_remove` is best effort, runs only for a workspace that exists, and never blocks removal.
    //
    // Removal frees the path before it deletes anything: the workspace is renamed into the trash
    // root and the trash root is then swept. A process that survived termination and is still
    // writing in the old directory therefore cannot corrupt the next attempt on this issue, and
    // deleting its files is no longer something that has to succeed for the workspace to be gone.
    // In the ordinary case the sweep deletes it in the same call, so removal is still complete when
    // this returns.
    remove: (identifier) =>
      Effect.gen(function* () {
        const key = workspaceKey(identifier)
        const path = yield* containedWorkspacePath(root, key)
        const exists = yield* workspaceDirectoryExists(fileSystem, path).pipe(
          reportedAs('remove_failed', 'failed to inspect workspace'),
        )
        if (exists) {
          if (hooks.beforeRemove !== null) {
            yield* runHook('before_remove', hooks.beforeRemove, path, hooks.timeoutMs).pipe(
              Effect.catchAll(() => Effect.void),
            )
          }
          yield* retireOrRemoveWorkspace(fileSystem, root, key, path).pipe(
            reportedAs('remove_failed', 'failed to remove workspace'),
          )
        }
        yield* sweepTrash(fileSystem, root)
      }),
  }))
