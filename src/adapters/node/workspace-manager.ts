import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Effect } from 'effect'

import type { HooksConfig } from '../../config/workflow.js'
import type { IssueIdentifier, Workspace } from '../../domain/domain.js'
import { containedWorkspacePath, workspaceKey } from '../../domain/workspace-containment.js'
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
    remove: (identifier) =>
      Effect.gen(function* () {
        const path = yield* containedWorkspacePath(root, workspaceKey(identifier))
        const exists = yield* workspaceDirectoryExists(fileSystem, path).pipe(
          reportedAs('remove_failed', 'failed to inspect workspace'),
        )
        if (!exists) {
          return
        }
        if (hooks.beforeRemove !== null) {
          yield* runHook('before_remove', hooks.beforeRemove, path, hooks.timeoutMs).pipe(
            Effect.catchAll(() => Effect.void),
          )
        }
        yield* fileSystem
          .remove(path, { force: true, recursive: true })
          .pipe(reportedAs('remove_failed', 'failed to remove workspace'))
      }),
  }))
