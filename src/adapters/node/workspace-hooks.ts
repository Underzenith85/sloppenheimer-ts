import { spawn } from 'node:child_process'
import { Effect } from 'effect'

import { WorkspaceError } from '../../errors.js'

/**
 * Operator-configured hook execution: child processes, bounded stream capture, timeouts, and the
 * termination of a hook's whole process tree. Nothing here decides workspace containment.
 */

export type HookPhase = 'after_create' | 'before_run' | 'after_run' | 'before_remove'

/** Diagnostic capture is bounded per stream; the stream itself is always drained. */
export const hookCaptureLimitBytes = 8 * 1024
/** Excerpt length used in error messages and logs. */
const hookExcerptLength = 1_000
/** Grace between the polite and forceful termination of a hook process tree. */
export const hookTerminationGraceMs = 5_000

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
