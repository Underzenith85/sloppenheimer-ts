import { createHash } from 'node:crypto'
import { mkdir, lstat, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
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

type HookPhase = 'after_create' | 'before_run' | 'after_run' | 'before_remove'

const DIAGNOSTIC_LIMIT_BYTES = 32 * 1024
const TERMINATION_GRACE_MS = 250

type CapturedOutput = {
  chunks: Buffer[]
  bytes: number
  truncated: boolean
}

const captureOutput = (capture: CapturedOutput, chunk: Buffer): void => {
  const remaining = DIAGNOSTIC_LIMIT_BYTES - capture.bytes
  if (remaining > 0) {
    const retained = chunk.subarray(0, remaining)
    capture.chunks.push(Buffer.from(retained))
    capture.bytes += retained.byteLength
  }
  if (chunk.byteLength > remaining) {
    capture.truncated = true
  }
}

const outputDiagnostic = (stdout: CapturedOutput, stderr: CapturedOutput): string => {
  const render = (name: string, capture: CapturedOutput): string | null => {
    const output = Buffer.concat(capture.chunks).toString('utf8').trim()
    if (output.length === 0 && !capture.truncated) {
      return null
    }
    const suffix = capture.truncated ? '\n[output truncated]' : ''
    return `${name}: ${output}${suffix}`
  }
  return [render('stderr', stderr), render('stdout', stdout)]
    .filter((part) => part !== null)
    .join('\n')
}

const causeCode = (cause: unknown): unknown =>
  typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined

const runShellProcess = (
  script: string,
  cwd: string,
  timeoutMs: number,
): Effect.Effect<void, WorkspaceError> =>
  Effect.async<void, WorkspaceError>((resume) => {
    const stdout: CapturedOutput = { chunks: [], bytes: 0, truncated: false }
    const stderr: CapturedOutput = { chunks: [], bytes: 0, truncated: false }
    let child: ChildProcess
    try {
      child = spawn('bash', ['-lc', script], {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (cause: unknown) {
      resume(
        Effect.fail(
          new WorkspaceError({
            category: 'hook_failed',
            message: 'failed to execute hook',
            cause,
          }),
        ),
      )
      return
    }

    let settled = false
    let closed = false
    let cancelling = false
    let timedOut = false
    let forceSent = false
    let processError: unknown
    let timeoutTimer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined
    let terminationTimer: NodeJS.Timeout | undefined
    let finishCancellation: (() => void) | undefined

    const onStdout = (chunk: Buffer): void => captureOutput(stdout, chunk)
    const onStderr = (chunk: Buffer): void => captureOutput(stderr, chunk)

    const clearTimer = (timer: NodeJS.Timeout | undefined): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }

    const removeListeners = (): void => {
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      child.off('error', onError)
      child.off('close', onClose)
    }

    const cleanup = (): void => {
      clearTimer(timeoutTimer)
      clearTimer(graceTimer)
      clearTimer(terminationTimer)
      removeListeners()
    }

    const finish = (result: Effect.Effect<void, WorkspaceError>): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resume(result)
    }

    const signalProcessTree = (signal: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined) {
        return
      }
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, signal)
          return
        } catch (cause: unknown) {
          if (causeCode(cause) === 'ESRCH') {
            return
          }
        }
      }
      child.kill(signal)
    }

    const forceProcessTree = (): void => {
      forceSent = true
      if (process.platform === 'win32' && child.pid !== undefined) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
        })
        killer.once('error', (): void => {})
        killer.unref()
        if (closed) {
          finishTermination()
        }
        return
      }
      signalProcessTree('SIGKILL')
      if (closed) {
        finishTermination()
      }
    }

    const failureMessage = (summary: string): string => {
      const diagnostic = outputDiagnostic(stdout, stderr)
      return diagnostic.length === 0 ? summary : `${summary}\n${diagnostic}`
    }

    const finishTermination = (): void => {
      if (finishCancellation !== undefined) {
        const finishCleanup = finishCancellation
        finishCancellation = undefined
        settled = true
        cleanup()
        finishCleanup()
        return
      }
      if (timedOut) {
        finish(
          Effect.fail(
            new WorkspaceError({
              category: 'hook_timeout',
              message: failureMessage(`hook timed out after ${String(timeoutMs)}ms`),
            }),
          ),
        )
        return
      }
      finish(
        Effect.fail(
          new WorkspaceError({
            category: 'hook_failed',
            message: failureMessage('failed to execute hook'),
            cause: processError,
          }),
        ),
      )
    }

    const terminate = (): void => {
      signalProcessTree('SIGTERM')
      graceTimer = setTimeout(forceProcessTree, TERMINATION_GRACE_MS)
      terminationTimer = setTimeout(finishTermination, TERMINATION_GRACE_MS * 2)
    }

    function onError(cause: Error): void {
      if (settled || cancelling || processError !== undefined) {
        return
      }
      processError = cause
      clearTimer(timeoutTimer)
      terminate()
    }

    function onClose(code: number | null, signal: NodeJS.Signals | null): void {
      if (settled) {
        return
      }
      closed = true
      if (finishCancellation !== undefined || timedOut || processError !== undefined) {
        if (forceSent) {
          finishTermination()
        }
        return
      }
      if (code === 0) {
        finish(Effect.void)
        return
      }
      const status = code === null ? `signal ${signal ?? 'unknown'}` : `code ${String(code)}`
      finish(
        Effect.fail(
          new WorkspaceError({
            category: 'hook_failed',
            message: failureMessage(`hook exited with ${status}`),
          }),
        ),
      )
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
    timeoutTimer = setTimeout(() => {
      if (settled || cancelling) {
        return
      }
      timedOut = true
      terminate()
    }, timeoutMs)

    return Effect.async<void>((resumeCancellation) => {
      if (settled || closed) {
        cleanup()
        resumeCancellation(Effect.void)
        return
      }
      cancelling = true
      clearTimer(timeoutTimer)
      finishCancellation = (): void => resumeCancellation(Effect.void)
      terminate()
    })
  })

const runShell = (
  phase: HookPhase,
  script: string,
  cwd: string,
  timeoutMs: number,
): Effect.Effect<void, WorkspaceError> =>
  Effect.logInfo('workspace hook started', { hook: phase }).pipe(
    Effect.zipRight(runShellProcess(script, cwd, timeoutMs)),
    Effect.tap(() => Effect.logInfo('workspace hook completed', { hook: phase })),
    Effect.tapError((error) =>
      error.category === 'hook_timeout'
        ? Effect.logWarning('workspace hook timed out', { hook: phase, timeoutMs })
        : Effect.logWarning('workspace hook failed', { hook: phase, category: error.category }),
    ),
    Effect.onInterrupt(() => Effect.logWarning('workspace hook cancelled', { hook: phase })),
  )

export type WorkspaceManager = Readonly<{
  create: (identifier: IssueIdentifier) => Effect.Effect<Workspace, WorkspaceError>
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
        return { path, key, createdNow } as const
      },
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
          ? runShell('after_create', hooks.afterCreate, workspace.path, hooks.timeoutMs).pipe(
              Effect.as(workspace),
            )
          : Effect.succeed(workspace),
      ),
    ),
  beforeRun: (workspace) =>
    hooks.beforeRun === null
      ? Effect.void
      : runShell('before_run', hooks.beforeRun, workspace.path, hooks.timeoutMs),
  afterRun: (workspace) =>
    hooks.afterRun === null
      ? Effect.void
      : runShell('after_run', hooks.afterRun, workspace.path, hooks.timeoutMs).pipe(
          Effect.catchAll(() => Effect.void),
        ),
  remove: (identifier) => {
    const path = containedWorkspacePath(root, workspaceKey(identifier))
    const pathExists = Effect.tryPromise({
      try: async () => {
        let exists = true
        try {
          await lstat(path)
        } catch (cause: unknown) {
          if (causeCode(cause) === 'ENOENT') {
            exists = false
          } else {
            throw cause
          }
        }
        return exists
      },
      catch: (cause: unknown) =>
        new WorkspaceError({
          category: 'remove_failed',
          message: 'failed to remove workspace',
          cause,
        }),
    })
    const removePath = Effect.tryPromise({
      try: () => rm(path, { force: true, recursive: true }),
      catch: (cause: unknown) =>
        new WorkspaceError({
          category: 'remove_failed',
          message: 'failed to remove workspace',
          cause,
        }),
    })
    return pathExists.pipe(
      Effect.flatMap((exists) =>
        exists && hooks.beforeRemove !== null
          ? runShell('before_remove', hooks.beforeRemove, path, hooks.timeoutMs).pipe(
              Effect.catchAll(() => Effect.void),
              Effect.zipRight(removePath),
            )
          : removePath,
      ),
    )
  },
})
