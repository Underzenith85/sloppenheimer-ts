import { Clock, Effect } from 'effect'

import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import { logInfo, logWarning } from '@sloppenheimer/core/support/logging.js'
import { runCommand } from './command.js'

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
export const hookTerminationGraceMs = 1_000

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

const runHookProcess = (
  script: string,
  cwd: string,
  timeoutMs: number,
): Effect.Effect<HookOutcome, WorkspaceError> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const result = yield* runCommand({
      command: 'bash',
      args: ['-lc', script],
      cwd,
      timeoutMs,
      captureLimit: hookCaptureLimitBytes,
      terminationGraceMs: hookTerminationGraceMs,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceError({
            category: cause.category === 'timed_out' ? 'hook_timeout' : 'hook_failed',
            message:
              cause.category === 'timed_out'
                ? `hook timed out after ${String(timeoutMs)}ms`
                : 'failed to start hook',
            cause,
          }),
      ),
    )
    return {
      ...result,
      stdout: result.stdout.trim() + (result.stdoutTruncated ? '… (truncated)' : ''),
      stderr: result.stderr.trim() + (result.stderrTruncated ? '… (truncated)' : ''),
      durationMs: (yield* Clock.currentTimeMillis) - startedAt,
    }
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
  logInfo('hook started', { hook: phase, cwd, timeout_ms: timeoutMs }).pipe(
    Effect.zipRight(runHookProcess(script, cwd, timeoutMs)),
    Effect.matchEffect({
      onFailure: (error) =>
        logWarning(error.category === 'hook_timeout' ? 'hook timed out' : 'hook could not start', {
          hook: phase,
          cwd,
          error: error.message,
        }).pipe(Effect.zipRight(Effect.fail(error))),
      onSuccess: (outcome) => {
        if (outcome.code === 0) {
          return logInfo('hook completed', {
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
        return logWarning('hook failed', {
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
