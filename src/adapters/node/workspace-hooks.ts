import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { Clock, Effect } from 'effect'

import { WorkspaceError } from '../../errors.js'
import { processGroupIsAlive } from '../../support/subprocess.js'

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
  /** Set when the pipe itself failed, so the head that was read is not reported as the whole of it. */
  interrupted: boolean
}

const makeCapture = (): StreamCapture => ({
  chunks: [],
  capturedBytes: 0,
  totalBytes: 0,
  interrupted: false,
})

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
  return capture.interrupted || capture.totalBytes > capture.capturedBytes
    ? `${text}… (truncated)`
    : text
}

/**
 * Drains one output pipe into its capture.
 *
 * A pipe that fails is recorded rather than raised. What a hook writes is diagnostic — its contract
 * is the exit code — so losing part of it must not turn a hook that succeeded into a failure. It
 * must not be reported as the whole of the output either, so the capture is marked and reads back
 * truncated. Attaching the listener at all is what keeps an `error` on the stream from reaching
 * Node's uncaught-exception path and taking the host down with it.
 */
const captureStream = (stream: Readable, capture: StreamCapture): void => {
  stream.on('data', (chunk: Buffer) => {
    appendCapture(capture, chunk)
  })
  stream.on('error', () => {
    capture.interrupted = true
  })
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
  Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
    Effect.async<HookOutcome, WorkspaceError>((resume) => {
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
       * Whether the hook's original process group still has a member that can run. Used to decide
       * whether the forceful escalation is still needed; a group with no running member must never be
       * signalled again, because its leader's PID can be recycled. Zombies do not count as members:
       * on a host that does not reap orphans they would otherwise keep a killed tree reporting alive.
       */
      const hookGroupIsAlive = (): boolean => {
        const { pid } = child
        return pid !== undefined && processGroupIsAlive(pid)
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
        // The escalation survives settlement only while the group still has a running member: a
        // descendant that ignores `SIGTERM` and redirected its inherited pipes lets the shell emit
        // `close` while the group is alive, so cancelling here would let it run on. Once nothing but
        // zombies is left the timer is cancelled, so a recycled leader PID is never signalled and a
        // host that does not reap orphans cannot strand the escalation.
        if (graceTimer !== undefined && !hookGroupIsAlive()) {
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
        // The hook's process tree can outlive settlement — that is what the retained escalation
        // above is for — so the child and its two pipes are left with listeners rather than bare.
        // Node rethrows an `error` event that has none as an uncaught exception, which would take
        // the host down instead of failing the hook that owns it.
        child.on('error', () => {})
        child.stdout.on('error', () => {})
        child.stderr.on('error', () => {})
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

      captureStream(child.stdout, stdout)
      captureStream(child.stderr, stderr)

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
          Effect.map(Clock.currentTimeMillis, (finishedAt) => ({
            code,
            signal,
            stdout: captureText(stdout),
            stderr: captureText(stderr),
            stdoutBytes: stdout.totalBytes,
            stderrBytes: stderr.totalBytes,
            durationMs: finishedAt - startedAt,
          })),
        )
      })

      timeoutTimer = setTimeout(() => {
        timedOut = true
        terminate('SIGTERM')
        graceTimer = setTimeout(() => {
          // Re-checked at fire time as well, so an escalation retained at `close` is dropped if the
          // group emptied during the grace period.
          if (hookGroupIsAlive()) {
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
          if (hookGroupIsAlive()) {
            terminate('SIGKILL')
          }
        }, hookTerminationGraceMs).unref()
      })
    }),
  )

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
