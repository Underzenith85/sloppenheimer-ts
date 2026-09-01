import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { Clock, Effect } from 'effect'

import { WorkspaceError } from '@symphony/core/domain/errors.js'
import {
  childProcessGroupIsAlive,
  detachChildProcess,
  resumeOnce,
  signalChildGroup,
} from '@symphony/core/support/subprocess.js'

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

const hookTimeout = (timeoutMs: number): Effect.Effect<never, WorkspaceError> =>
  Effect.fail(
    new WorkspaceError({
      category: 'hook_timeout',
      message: `hook timed out after ${String(timeoutMs)}ms`,
    }),
  )

/** Reports a hook that ran to completion, reading the clock once for its duration. */
const hookCompletion = (
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: StreamCapture,
  stderr: StreamCapture,
  startedAt: number,
): Effect.Effect<HookOutcome> =>
  Effect.map(Clock.currentTimeMillis, (finishedAt) => ({
    code,
    signal,
    stdout: captureText(stdout),
    stderr: captureText(stderr),
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
    durationMs: finishedAt - startedAt,
  }))

/**
 * Terminates a hook's whole process tree: politely first, forcefully after a bounded grace.
 *
 * The escalation timer is returned so the settlement path can drop it, and is unreferenced so a
 * hook nobody is waiting on any more cannot hold the host open until the grace expires.
 */
const terminateHookTree = (child: ChildProcess, onEscalated: () => void): NodeJS.Timeout => {
  signalChildGroup(child, 'SIGTERM')
  const graceTimer = setTimeout(() => {
    // Re-checked at fire time as well, so an escalation retained at `close` is dropped if the
    // group emptied during the grace period.
    if (childProcessGroupIsAlive(child)) {
      signalChildGroup(child, 'SIGKILL')
    }
    onEscalated()
  }, hookTerminationGraceMs)
  graceTimer.unref()
  return graceTimer
}

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
      let timedOut = false
      let timeoutTimer: NodeJS.Timeout | undefined
      let graceTimer: NodeJS.Timeout | undefined

      const child = spawn('bash', ['-lc', script], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })

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
        if (graceTimer !== undefined && !childProcessGroupIsAlive(child)) {
          clearTimeout(graceTimer)
          graceTimer = undefined
        }
      }

      // The hook's process tree can outlive settlement — that is what the retained escalation in
      // `clearTimers` is for — so releasing the child leaves it and its two pipes with no-op
      // listeners rather than bare.
      const { settle, claim } = resumeOnce(resume, () => {
        clearTimers()
        detachChildProcess(child)
      })

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
        settle(
          timedOut
            ? hookTimeout(timeoutMs)
            : hookCompletion(code, signal, stdout, stderr, startedAt),
        )
      })

      timeoutTimer = setTimeout(() => {
        timedOut = true
        graceTimer = terminateHookTree(child, () => {
          settle(hookTimeout(timeoutMs))
        })
      }, timeoutMs)

      // Interruption: a hook nobody is waiting on any more must not keep running in a workspace
      // that is about to be removed, but one that already settled has nothing left to terminate.
      return Effect.sync(() => {
        if (claim()) {
          terminateHookTree(child, () => {})
        }
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
