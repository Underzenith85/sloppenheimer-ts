import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import * as NodeStream from '@effect/platform-node/NodeStream'
import { Effect, Stream } from 'effect'

import { AgentError } from '@sloppenheimer/core/domain/errors.js'
import { diagnosticLines, diagnosticRecords, protocolLines } from './framing.js'
import { codexMaxLineBytes } from './session.js'

/**
 * The two readers a session runs against its child's output.
 *
 * Each is an effect the session forks against its own scope, so a reader belongs to the run rather
 * than to the default runtime. Framing state lives in the pipeline rather than in the connection,
 * which is what lets the framing limit end a read the way any other protocol error does.
 */

/**
 * Reads protocol lines from stdout, which carries framing only.
 *
 * A read that fails is a session failure: the protocol is how the session is driven, so losing it
 * mid-turn is not something the turn can continue through.
 */
export const protocolReader = (
  child: ChildProcessWithoutNullStreams,
  onLine: (line: string) => Effect.Effect<void, AgentError>,
  onFailure: (error: AgentError) => Effect.Effect<void>,
): Effect.Effect<void> =>
  NodeStream.fromReadable<AgentError>(
    () => child.stdout,
    (cause) =>
      new AgentError({ category: 'protocol_error', message: 'Codex stdout failed', cause }),
  ).pipe(protocolLines(codexMaxLineBytes), Stream.runForEach(onLine), Effect.catchAll(onFailure))

/**
 * Reads diagnostic records from stderr, which is never parsed as protocol.
 *
 * Complete records are assembled before redaction: a chunk boundary between `Authorization:` and
 * its value must not turn the value into an unkeyed fragment that can escape the header redactor. A
 * read that fails is the end of the diagnostics rather than a session failure, and ends the stream
 * so that whatever record was still open is flushed.
 */
export const diagnosticReader = (
  child: ChildProcessWithoutNullStreams,
  onRecord: (message: string) => Effect.Effect<void>,
): Effect.Effect<void> =>
  NodeStream.fromReadable<AgentError>(
    () => child.stderr,
    (cause) =>
      new AgentError({ category: 'protocol_error', message: 'Codex stderr failed', cause }),
    // The pipe outlives the reader. Closing it under a child that is still running would fail its
    // diagnostic writes, so the reader gives up on the record and leaves the pipe open.
    { closeOnDone: false },
  ).pipe(
    Stream.catchAll(() => Stream.empty),
    diagnosticLines(codexMaxLineBytes),
    diagnosticRecords,
    Stream.runForEach(onRecord),
    Effect.catchAll(() =>
      onRecord('Codex diagnostic line exceeded the framing limit').pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // Framing has given up on this stream, but the child has not stopped writing to it.
            // Keep emptying the pipe and discard what arrives: a full stderr buffer blocks the App
            // Server mid-protocol, which would turn a diagnostic-only overflow into a dead turn.
            child.stderr.resume()
          }),
        ),
      ),
    ),
  )
