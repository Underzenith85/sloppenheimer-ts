import { createHash } from 'node:crypto'
import { mkdir, lstat, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { Effect } from 'effect'

import type { IssueIdentifier, Workspace } from './domain.js'
import { WorkspaceError } from './errors.js'
import type { HooksConfig } from './workflow.js'

export const workspaceKey = (identifier: IssueIdentifier): string => {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/gu, '_')
  if (sanitized === identifier) {
    return sanitized
  }
  const suffix = createHash('sha256').update(identifier).digest('hex').slice(0, 16)
  return `${sanitized}-${suffix}`
}

export const containedWorkspacePath = (root: string, key: string): string => {
  const normalizedRoot = resolve(root)
  const candidate = resolve(normalizedRoot, key)
  const difference = relative(normalizedRoot, candidate)
  if (
    difference === '' ||
    isAbsolute(difference) ||
    difference === '..' ||
    difference.startsWith(`..${sep}`)
  ) {
    throw new WorkspaceError({
      category: 'invalid_path',
      message: `workspace path escapes or equals root: ${candidate}`,
    })
  }
  return candidate
}

const runShell = (
  script: string,
  cwd: string,
  timeoutMs: number,
): Effect.Effect<void, WorkspaceError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn('bash', ['-lc', script], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        const stderr: Buffer[] = []
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        const timeout = setTimeout(() => {
          child.kill('SIGTERM')
          rejectPromise(
            new WorkspaceError({
              category: 'hook_timeout',
              message: `hook timed out after ${String(timeoutMs)}ms`,
            }),
          )
        }, timeoutMs)
        child.once('error', rejectPromise)
        child.once('exit', (code) => {
          clearTimeout(timeout)
          if (code === 0) {
            resolvePromise()
          } else {
            rejectPromise(
              new WorkspaceError({
                category: 'hook_failed',
                message: `hook exited with ${String(code)}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
              }),
            )
          }
        })
      }),
    catch: (cause: unknown) =>
      cause instanceof WorkspaceError
        ? cause
        : new WorkspaceError({ category: 'hook_failed', message: 'failed to execute hook', cause }),
  })

export type WorkspaceManager = Readonly<{
  create: (identifier: IssueIdentifier) => Effect.Effect<Workspace, WorkspaceError>
  exists: (identifier: IssueIdentifier) => Effect.Effect<boolean, WorkspaceError>
  beforeRun: (workspace: Workspace) => Effect.Effect<void, WorkspaceError>
  afterRun: (workspace: Workspace) => Effect.Effect<void>
  remove: (identifier: IssueIdentifier) => Effect.Effect<void, WorkspaceError>
}>

export const makeWorkspaceManager = (root: string, hooks: HooksConfig): WorkspaceManager => ({
  create: (identifier) =>
    Effect.tryPromise({
      try: async () => {
        const key = workspaceKey(identifier)
        const path = containedWorkspacePath(root, key)
        await mkdir(root, { recursive: true })
        let createdNow = false
        try {
          const info = await lstat(path)
          if (!info.isDirectory()) {
            throw new WorkspaceError({
              category: 'invalid_path',
              message: `workspace exists and is not a directory: ${path}`,
            })
          }
        } catch (cause: unknown) {
          if (cause instanceof WorkspaceError) {
            throw cause
          }
          const code =
            typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
          if (code !== 'ENOENT') {
            throw cause
          }
          await mkdir(path)
          createdNow = true
        }
        const workspace = { path, key, createdNow } as const
        if (createdNow && hooks.afterCreate !== null) {
          await Effect.runPromise(runShell(hooks.afterCreate, path, hooks.timeoutMs))
        }
        return workspace
      },
      catch: (cause: unknown) =>
        cause instanceof WorkspaceError
          ? cause
          : new WorkspaceError({
              category: 'create_failed',
              message: 'failed to create workspace',
              cause,
            }),
    }),
  exists: (identifier) =>
    Effect.tryPromise({
      try: async () => {
        const path = containedWorkspacePath(root, workspaceKey(identifier))
        try {
          await lstat(path)
          return true
        } catch (cause: unknown) {
          const code =
            typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
          if (code === 'ENOENT') {
            return false
          }
          throw cause
        }
      },
      catch: (cause: unknown) =>
        new WorkspaceError({
          category: 'inspect_failed',
          message: 'failed to inspect workspace',
          cause,
        }),
    }),
  beforeRun: (workspace) =>
    hooks.beforeRun === null
      ? Effect.void
      : runShell(hooks.beforeRun, workspace.path, hooks.timeoutMs),
  afterRun: (workspace) =>
    hooks.afterRun === null
      ? Effect.void
      : runShell(hooks.afterRun, workspace.path, hooks.timeoutMs).pipe(
          Effect.catchAll((error) => Effect.logWarning('after_run hook failed', { error })),
        ),
  remove: (identifier) =>
    Effect.tryPromise({
      try: async () => {
        const path = containedWorkspacePath(root, workspaceKey(identifier))
        try {
          await lstat(path)
        } catch (cause: unknown) {
          const code =
            typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
          if (code === 'ENOENT') {
            return
          }
          throw cause
        }
        if (hooks.beforeRemove !== null) {
          await Effect.runPromise(
            runShell(hooks.beforeRemove, path, hooks.timeoutMs).pipe(
              Effect.catchAll((error) =>
                Effect.logWarning('before_remove hook failed; continuing cleanup', {
                  issue_identifier: identifier,
                  workspace_path: path,
                  error: error.message,
                }),
              ),
            ),
          )
        }
        await rm(path, { force: true, recursive: true })
      },
      catch: (cause: unknown) =>
        new WorkspaceError({
          category: 'remove_failed',
          message: 'failed to remove workspace',
          cause,
        }),
    }),
})
