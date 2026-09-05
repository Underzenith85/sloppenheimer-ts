import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'
import { Effect, Layer } from 'effect'

import { SubprocessError } from '@sloppenheimer/core/domain/errors.js'
import {
  CommandExecutor,
  type CommandRequest,
  type CommandResult,
} from '@sloppenheimer/core/ports/command.js'
import { openProcess } from './process.js'

type Capture = {
  chunks: Buffer[]
  bytes: number
  captured: number
  interrupted: boolean
}

const capture = (stream: Readable, limit: number): Capture => {
  const output: Capture = { chunks: [], bytes: 0, captured: 0, interrupted: false }
  stream.on('data', (chunk: Buffer) => {
    output.bytes += chunk.byteLength
    const remaining = limit - output.captured
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining)
      output.chunks.push(retained)
      output.captured += retained.byteLength
    }
  })
  stream.on('error', () => {
    output.interrupted = true
  })
  return output
}

const awaitCommand = (
  child: ChildProcessWithoutNullStreams,
  request: CommandRequest,
): Effect.Effect<CommandResult, SubprocessError> =>
  Effect.async((resume) => {
    const stdout = capture(child.stdout, request.captureLimit)
    const stderr = capture(child.stderr, request.captureLimit)
    let settled = false
    const settle = (result: Effect.Effect<CommandResult, SubprocessError>): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resume(result)
      }
    }
    // This times a real child, so it uses a native timer even under a test clock.
    const timer = setTimeout(
      () =>
        settle(
          Effect.fail(
            new SubprocessError({
              category: 'timed_out',
              message: `subprocess exceeded its ${String(request.timeoutMs)}ms deadline`,
            }),
          ),
        ),
      request.timeoutMs,
    )
    child.once('error', (cause: unknown) =>
      settle(
        Effect.fail(
          new SubprocessError({
            category: 'spawn_failed',
            message: 'subprocess failed to start',
            cause,
          }),
        ),
      ),
    )
    child.once('close', (code, signal) =>
      settle(
        Effect.succeed({
          code,
          signal,
          stdout: Buffer.concat(stdout.chunks).toString('utf8'),
          stderr: Buffer.concat(stderr.chunks).toString('utf8'),
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
          stdoutTruncated: stdout.interrupted || stdout.bytes > stdout.captured,
          stderrTruncated: stderr.interrupted || stderr.bytes > stderr.captured,
          outputInterrupted: stdout.interrupted || stderr.interrupted,
        }),
      ),
    )
    child.stdin.end()
    return Effect.sync(() => {
      settled = true
      clearTimeout(timer)
    })
  })

/** The process scope closes on every outcome, including deadline and owner interruption. */
export const runCommand = (
  request: CommandRequest,
): Effect.Effect<CommandResult, SubprocessError> => {
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(request.captureLimit) ||
    request.captureLimit < 0
  ) {
    return Effect.fail(
      new SubprocessError({
        category: 'invalid_request',
        message: 'invalid subprocess deadline or capture limit',
      }),
    )
  }
  return Effect.scoped(
    Effect.flatMap(openProcess(request), (child) => awaitCommand(child, request)),
  )
}

export const layerCommandExecutor = Layer.succeed(CommandExecutor, { run: runCommand })
