import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Effect, type Scope } from 'effect'

import type { IssueIdentifier, Workspace } from './domain.js'
import { WorkspaceError } from './errors.js'
import type { HooksConfig } from './workflow.js'

export type HookPhase = 'after_create' | 'before_run' | 'after_run' | 'before_remove'

/** Diagnostic capture is bounded per stream; the stream itself is always drained. */
export const hookCaptureLimitBytes = 8 * 1024
/** Excerpt length used in error messages and logs. */
const hookExcerptLength = 1_000
/** Grace between the polite and forceful termination of a hook process tree. */
export const hookTerminationGraceMs = 5_000

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

const isStrictDescendant = (root: string, candidate: string): boolean => {
  const difference = relative(root, candidate)
  return (
    difference !== '' &&
    !isAbsolute(difference) &&
    difference !== '..' &&
    !difference.startsWith(`..${sep}`)
  )
}

const rejectWorkspace = (message: string): WorkspaceError =>
  new WorkspaceError({ category: 'invalid_path', message })

/**
 * The identity of a verified workspace directory. The path alone is not enough: a path string is
 * re-resolved by the kernel at every consumer, so the directory that a later consumer enters is
 * only known to be the verified one if its filesystem identity still matches.
 */
export type VerifiedWorkspace = Readonly<{
  /** The canonical path of the verified directory. */
  path: string
  /** The canonical path of the configured root it was verified against. */
  rootPath: string
  deviceId: number
  inode: number
}>

const directoryIdentity = async (path: string): Promise<Stats> => {
  let info: Stats
  try {
    info = await lstat(path)
  } catch {
    throw rejectWorkspace(`workspace directory is not present: ${path}`)
  }
  if (info.isSymbolicLink()) {
    throw rejectWorkspace(`workspace path is a symbolic link: ${path}`)
  }
  if (!info.isDirectory()) {
    throw rejectWorkspace(`workspace path is not a directory: ${path}`)
  }
  return info
}

const canonicalRoot = async (root: string): Promise<string> => {
  try {
    return await realpath(resolve(root))
  } catch {
    throw rejectWorkspace(`configured workspace root is not present: ${resolve(root)}`)
  }
}

/**
 * The single containment invariant every executor must satisfy immediately before launching an
 * agent. Creation-time checks are not enough: a `Workspace` value can be stale, forged, or the
 * directory can have been replaced since it was produced.
 *
 * Returns the canonical workspace path, the canonical root it was checked against, and the device
 * and inode that path resolved to, so every later consumer can confirm it is the same directory.
 */
export const verifyWorkspaceForLaunch = (
  root: string,
  workspace: Workspace,
): Effect.Effect<VerifiedWorkspace, WorkspaceError> =>
  Effect.tryPromise({
    try: async () => {
      const normalizedRoot = resolve(root)
      const declaredPath = resolve(workspace.path)
      if (!isStrictDescendant(normalizedRoot, declaredPath)) {
        throw rejectWorkspace(
          `workspace path is not a strict descendant of the configured root: ${declaredPath}`,
        )
      }
      await directoryIdentity(declaredPath)
      const rootPath = await canonicalRoot(normalizedRoot)
      const realWorkspace = await realpath(declaredPath)
      if (!isStrictDescendant(rootPath, realWorkspace)) {
        throw rejectWorkspace(
          `resolved workspace path escapes the configured root: ${realWorkspace}`,
        )
      }
      const resolved = await directoryIdentity(realWorkspace)
      return { path: realWorkspace, rootPath, deviceId: resolved.dev, inode: resolved.ino }
    },
    catch: (cause: unknown) =>
      cause instanceof WorkspaceError
        ? cause
        : rejectWorkspace('workspace containment could not be verified'),
  })

/**
 * Re-binds a verified workspace at a path-consuming boundary. Both the root and the workspace are
 * compared against the canonical values captured at verification, so a directory renamed and
 * replaced between verification and use is rejected instead of followed. The root is compared
 * canonically, so a configured root that is itself a symlink still verifies.
 */
export const assertWorkspaceIdentity = (
  root: string,
  verified: VerifiedWorkspace,
): Effect.Effect<void, WorkspaceError> =>
  Effect.tryPromise({
    try: async () => {
      const rootPath = await canonicalRoot(root)
      if (rootPath !== verified.rootPath) {
        throw rejectWorkspace(
          `configured workspace root changed since verification: ${verified.rootPath}`,
        )
      }
      if (!isStrictDescendant(rootPath, verified.path)) {
        throw rejectWorkspace(
          `verified workspace path no longer descends from the root: ${verified.path}`,
        )
      }
      const resolved = await directoryIdentity(verified.path)
      const current = await realpath(verified.path)
      if (
        current !== verified.path ||
        resolved.dev !== verified.deviceId ||
        resolved.ino !== verified.inode
      ) {
        throw rejectWorkspace(
          `workspace directory identity changed since verification: ${verified.path}`,
        )
      }
    },
    catch: (cause: unknown) =>
      cause instanceof WorkspaceError
        ? cause
        : rejectWorkspace('workspace identity could not be confirmed'),
  })

/**
 * Verifies containment and then holds an open handle on the verified directory for the caller's
 * scope. Holding the handle keeps the inode allocated, so a directory deleted and recreated at the
 * same path is guaranteed a different inode and cannot pass the identity check.
 */
export const openVerifiedWorkspace = (
  root: string,
  workspace: Workspace,
): Effect.Effect<VerifiedWorkspace, WorkspaceError, Scope.Scope> =>
  verifyWorkspaceForLaunch(root, workspace).pipe(
    Effect.flatMap((verified) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => open(verified.path, 'r'),
          catch: (cause: unknown) =>
            cause instanceof WorkspaceError
              ? cause
              : rejectWorkspace(`workspace directory could not be held open: ${verified.path}`),
        }),
        (handle) => Effect.promise(() => handle.close().catch(() => undefined)),
      ).pipe(
        // `open` resolves a path, so the handle itself is checked: only if it refers to the
        // verified inode does holding it actually keep that inode allocated.
        Effect.flatMap((handle) =>
          Effect.tryPromise({
            try: async () => {
              const held = await handle.stat()
              if (held.dev !== verified.deviceId || held.ino !== verified.inode) {
                throw rejectWorkspace(
                  `workspace handle does not refer to the verified directory: ${verified.path}`,
                )
              }
              return verified
            },
            catch: (cause: unknown) =>
              cause instanceof WorkspaceError
                ? cause
                : rejectWorkspace(`workspace handle could not be confirmed: ${verified.path}`),
          }),
        ),
      ),
    ),
    // With the correct inode pinned, confirm the path still resolves to it.
    Effect.tap((verified) => assertWorkspaceIdentity(root, verified)),
  )

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

type StreamCapture = {
  chunks: Buffer[]
  capturedBytes: number
  totalBytes: number
}

const makeCapture = (): StreamCapture => ({ chunks: [], capturedBytes: 0, totalBytes: 0 })

/** Keeps the head of a stream up to the capture limit while still consuming every chunk. */
const appendCapture = (capture: StreamCapture, chunk: Buffer): void => {
  capture.totalBytes += chunk.byteLength
  const remaining = hookCaptureLimitBytes - capture.capturedBytes
  if (remaining <= 0) {
    return
  }
  const slice = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
  capture.chunks.push(slice)
  capture.capturedBytes += slice.byteLength
}

const captureText = (capture: StreamCapture): string => {
  const text = Buffer.concat(capture.chunks).toString('utf8').trim()
  return capture.totalBytes > capture.capturedBytes ? `${text}… (truncated)` : text
}

const excerpt = (text: string): string =>
  text.length <= hookExcerptLength ? text : `${text.slice(0, hookExcerptLength)}… (truncated)`

type HookOutcome = Readonly<{
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  durationMs: number
}>

/**
 * Runs one hook script as its own process group.
 *
 * Both output streams are drained continuously so a chatty hook can never fill a pipe and hang,
 * while only a bounded head of each stream is kept for diagnostics. The effect settles exactly
 * once, every timer and listener is cleared on settlement, and a timeout or an Effect interruption
 * terminates the whole process tree — politely first, forcefully after a bounded grace.
 */
const runHookProcess = (
  script: string,
  cwd: string,
  timeoutMs: number,
): Effect.Effect<HookOutcome, WorkspaceError> =>
  Effect.async<HookOutcome, WorkspaceError>((resume) => {
    const startedAt = Date.now()
    const stdout = makeCapture()
    const stderr = makeCapture()
    let settled = false
    let timedOut = false
    let timeoutTimer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined

    const child = spawn('bash', ['-lc', script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    /**
     * Whether the hook's original process group still has a member. Used to decide whether the
     * forceful escalation is still needed; a group with no members must never be signalled again,
     * because its leader's PID can be recycled.
     */
    const processGroupIsAlive = (): boolean => {
      const { pid } = child
      if (pid === undefined) {
        return false
      }
      try {
        process.kill(-pid, 0)
        return true
      } catch {
        return false
      }
    }

    const terminate = (signal: NodeJS.Signals): void => {
      const { pid } = child
      if (pid === undefined) {
        return
      }
      try {
        process.kill(-pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // The process tree is already gone.
        }
      }
    }

    const clearTimers = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
        timeoutTimer = undefined
      }
      // The escalation survives settlement only while the group still has a member: a descendant
      // that ignores `SIGTERM` and redirected its inherited pipes lets the shell emit `close` while
      // the group is alive, so cancelling here would let it run on. Once the group is empty the
      // timer is cancelled, so a recycled leader PID is never signalled.
      if (graceTimer !== undefined && !processGroupIsAlive()) {
        clearTimeout(graceTimer)
        graceTimer = undefined
      }
    }

    const detach = (): void => {
      clearTimers()
      child.stdout.removeAllListeners()
      child.stderr.removeAllListeners()
      child.removeAllListeners('error')
      child.removeAllListeners('close')
    }

    const settle = (effect: Effect.Effect<HookOutcome, WorkspaceError>): void => {
      if (settled) {
        return
      }
      settled = true
      detach()
      resume(effect)
    }

    const timeoutFailure = (): Effect.Effect<HookOutcome, WorkspaceError> =>
      Effect.fail(
        new WorkspaceError({
          category: 'hook_timeout',
          message: `hook timed out after ${String(timeoutMs)}ms`,
        }),
      )

    child.stdout.on('data', (chunk: Buffer) => {
      appendCapture(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      appendCapture(stderr, chunk)
    })

    child.once('error', (cause: unknown) => {
      settle(
        Effect.fail(
          new WorkspaceError({ category: 'hook_failed', message: 'failed to start hook', cause }),
        ),
      )
    })

    // `close` rather than `exit`: both pipes are fully drained by then.
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        settle(timeoutFailure())
        return
      }
      settle(
        Effect.succeed({
          code,
          signal,
          stdout: captureText(stdout),
          stderr: captureText(stderr),
          stdoutBytes: stdout.totalBytes,
          stderrBytes: stderr.totalBytes,
          durationMs: Date.now() - startedAt,
        }),
      )
    })

    timeoutTimer = setTimeout(() => {
      timedOut = true
      terminate('SIGTERM')
      graceTimer = setTimeout(() => {
        // Re-checked at fire time as well, so an escalation retained at `close` is dropped if the
        // group emptied during the grace period.
        if (processGroupIsAlive()) {
          terminate('SIGKILL')
        }
        settle(timeoutFailure())
      }, hookTerminationGraceMs)
      graceTimer.unref()
    }, timeoutMs)

    return Effect.sync(() => {
      if (settled) {
        return
      }
      settled = true
      detach()
      terminate('SIGTERM')
      setTimeout(() => {
        if (processGroupIsAlive()) {
          terminate('SIGKILL')
        }
      }, hookTerminationGraceMs).unref()
    })
  })

/**
 * Runs a hook and reports it. The script text is never logged, and captured output is bounded, so
 * neither a credential embedded in a hook nor a chatty command reaches the log unbounded.
 */
export const runHook = (
  phase: HookPhase,
  script: string,
  cwd: string,
  timeoutMs: number,
): Effect.Effect<void, WorkspaceError> =>
  Effect.logInfo('hook started', { hook: phase, cwd, timeout_ms: timeoutMs }).pipe(
    Effect.zipRight(runHookProcess(script, cwd, timeoutMs)),
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logWarning(
          error.category === 'hook_timeout' ? 'hook timed out' : 'hook could not start',
          { hook: phase, cwd, error: error.message },
        ).pipe(Effect.zipRight(Effect.fail(error))),
      onSuccess: (outcome) => {
        if (outcome.code === 0) {
          return Effect.logInfo('hook completed', {
            hook: phase,
            cwd,
            duration_ms: outcome.durationMs,
            stdout_bytes: outcome.stdoutBytes,
            stderr_bytes: outcome.stderrBytes,
          })
        }
        const reason =
          outcome.signal === null
            ? `exited with ${String(outcome.code)}`
            : `terminated by ${outcome.signal}`
        return Effect.logWarning('hook failed', {
          hook: phase,
          cwd,
          duration_ms: outcome.durationMs,
          reason,
          stderr: excerpt(outcome.stderr),
        }).pipe(
          Effect.zipRight(
            Effect.fail(
              new WorkspaceError({
                category: 'hook_failed',
                message: `${phase} hook ${reason}: ${excerpt(outcome.stderr)}`,
              }),
            ),
          ),
        )
      },
    }),
  )

export type WorkspaceManager = Readonly<{
  create: (identifier: IssueIdentifier) => Effect.Effect<Workspace, WorkspaceError>
  exists: (identifier: IssueIdentifier) => Effect.Effect<boolean, WorkspaceError>
  beforeRun: (workspace: Workspace) => Effect.Effect<void, WorkspaceError>
  afterRun: (workspace: Workspace) => Effect.Effect<void>
  remove: (identifier: IssueIdentifier) => Effect.Effect<void, WorkspaceError>
}>

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

export const makeWorkspaceManager = (root: string, hooks: HooksConfig): WorkspaceManager => ({
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
