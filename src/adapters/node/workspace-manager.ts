import type { Stats } from 'node:fs'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { Effect } from 'effect'

import type { HooksConfig } from '../../config/workflow.js'
import type { IssueIdentifier, Workspace } from '../../domain/domain.js'
import { containedWorkspacePath, workspaceKey } from '../../domain/workspace-containment.js'
import { WorkspaceError } from '../../errors.js'
import type { WorkspaceManagerPort } from '../../ports/workspace.js'
import { runHook } from './workspace-hooks.js'

/**
 * The Node implementation of `WorkspaceManagerPort`: the per-issue directory lifecycle, with the
 * containment rules taken from `domain/workspace-containment.ts` and the hooks run by
 * `workspace-hooks.ts`.
 */

/**
 * Reports whether a usable workspace directory is present. A path that exists but is not a real
 * directory — a file, or a symbolic link pointing elsewhere — is rejected rather than treated as a
 * workspace, so cleanup can never follow a substituted path.
 */
const workspaceDirectoryExists = async (path: string): Promise<boolean> => {
  let info: Stats
  try {
    info = await lstat(path)
  } catch (cause: unknown) {
    const code =
      typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
    if (code === 'ENOENT') {
      return false
    }
    throw cause
  }
  if (!info.isDirectory()) {
    throw new WorkspaceError({
      category: 'invalid_path',
      message: `workspace exists and is not a directory: ${path}`,
    })
  }
  return true
}

const prepareWorkspace = async (root: string, identifier: IssueIdentifier): Promise<Workspace> => {
  const key = workspaceKey(identifier)
  const path = containedWorkspacePath(root, key)
  await mkdir(root, { recursive: true })
  if (await workspaceDirectoryExists(path)) {
    return { path, key, createdNow: false }
  }
  await mkdir(path)
  return { path, key, createdNow: true }
}

const removeFailure = (cause: unknown, message: string): WorkspaceError =>
  cause instanceof WorkspaceError
    ? cause
    : new WorkspaceError({ category: 'remove_failed', message, cause })

export const makeWorkspaceManager = (root: string, hooks: HooksConfig): WorkspaceManagerPort => ({
  // `after_create` is fatal: a workspace whose provisioning hook failed is not usable.
  create: (identifier) =>
    Effect.tryPromise({
      try: () => prepareWorkspace(root, identifier),
      catch: (cause: unknown) =>
        cause instanceof WorkspaceError
          ? cause
          : new WorkspaceError({
              category: 'create_failed',
              message: 'failed to create workspace',
              cause,
            }),
    }).pipe(
      Effect.flatMap((workspace) =>
        workspace.createdNow && hooks.afterCreate !== null
          ? runHook('after_create', hooks.afterCreate, workspace.path, hooks.timeoutMs).pipe(
              Effect.as(workspace),
            )
          : Effect.succeed(workspace),
      ),
    ),
  exists: (identifier) =>
    Effect.suspend(() =>
      Effect.tryPromise({
        try: () => workspaceDirectoryExists(containedWorkspacePath(root, workspaceKey(identifier))),
        catch: (cause: unknown) =>
          cause instanceof WorkspaceError
            ? cause
            : new WorkspaceError({
                category: 'inspect_failed',
                message: 'failed to inspect workspace',
                cause,
              }),
      }),
    ).pipe(
      Effect.catchAllDefect((defect: unknown) =>
        Effect.fail(
          defect instanceof WorkspaceError
            ? defect
            : new WorkspaceError({
                category: 'inspect_failed',
                message: 'failed to inspect workspace',
                cause: defect,
              }),
        ),
      ),
    ),
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
    Effect.suspend(() => {
      const path = containedWorkspacePath(root, workspaceKey(identifier))
      return Effect.tryPromise({
        try: () => workspaceDirectoryExists(path),
        catch: (cause: unknown) => removeFailure(cause, 'failed to inspect workspace'),
      }).pipe(
        Effect.flatMap((exists) => {
          if (!exists) {
            return Effect.void
          }
          const beforeRemove =
            hooks.beforeRemove === null
              ? Effect.void
              : runHook('before_remove', hooks.beforeRemove, path, hooks.timeoutMs).pipe(
                  Effect.catchAll(() => Effect.void),
                )
          return beforeRemove.pipe(
            Effect.zipRight(
              Effect.tryPromise({
                try: () => rm(path, { force: true, recursive: true }),
                catch: (cause: unknown) => removeFailure(cause, 'failed to remove workspace'),
              }),
            ),
          )
        }),
      )
    }).pipe(
      Effect.catchAllDefect((defect: unknown) =>
        Effect.fail(removeFailure(defect, 'failed to remove workspace')),
      ),
    ),
})
