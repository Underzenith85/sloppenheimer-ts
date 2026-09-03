import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Deferred, Effect, Fiber, Option, Queue, Ref } from 'effect'

import type { JsonObject, JsonValue } from '@sloppenheimer/core/domain/domain.js'
import { AgentError } from '@sloppenheimer/core/domain/errors.js'
import type { HostToolSession } from '@sloppenheimer/core/domain/host-tools.js'
import { currentInstant } from '@sloppenheimer/core/support/clock.js'
import type { Redactor } from '@sloppenheimer/core/support/redaction.js'
import type { AgentEvent, AgentLifecycle } from '@sloppenheimer/core/telemetry.js'
import {
  claimOutstanding,
  expirePending,
  registerRequest,
  type ConnectionStateRef,
  type TurnState,
} from './connection-state.js'
import { sessionEvent } from './events.js'
import { clientPayload } from './payload.js'
import type { ProtocolIdentity } from './protocol.js'
import { boundedMessage, codexTurnOutcome } from './session.js'

/**
 * The resources one App Server session runs on, and what every part of it may do with them.
 *
 * The session is a record rather than an object with methods, so each operation below states what
 * it needs of the session in its own signature and none of them can reach for anything else. The
 * connection in `connection.ts` is the only thing that builds one.
 */

/**
 * How a session starts its readers. The caller supplies it from the runtime and scope the session
 * runs in, so a reader is a child of that scope rather than a fiber on the default runtime: one
 * left running by a session that never stopped cleanly is interrupted when the scope closes.
 */
export type ForkReader = (reader: Effect.Effect<void>) => Fiber.RuntimeFiber<void>

/** The two fibers reading the child's output: protocol on stdout, diagnostics on stderr. */
export type SessionReaders = Readonly<{
  stdout: Fiber.RuntimeFiber<void>
  stderr: Fiber.RuntimeFiber<void>
}>

export type SessionRuntime = Readonly<{
  process: ChildProcessWithoutNullStreams
  state: ConnectionStateRef
  onEvent: (event: AgentEvent) => void
  /**
   * Resolved from the host environment rather than read out of the subprocess's: the tracker's own
   * secret is stripped from what Codex inherits, and a value the agent never receives is exactly
   * the one most worth removing if some tool prints it back.
   */
  knownSecretValues: readonly string[]
  /**
   * Shape-based redaction over the same known secret values, applied at the parser so a credential
   * a message carried is gone before any consumer — the timeline, a log, an HTTP response — can
   * retain it.
   */
  redact: Redactor
  hostTools: HostToolSession | null
  fork: ForkReader
  /** Serializes response side effects with session-terminal failure. */
  lifecycle: Effect.Semaphore
  readTimeoutMs: number
  turnTimeoutMs: number
}>

export const processIdOf = (session: SessionRuntime): number | null => session.process.pid ?? null

/**
 * Reports the child's own lifecycle as a session failure. An exit is only a failure while the
 * session is still open: one that has stopped closed the process itself.
 *
 * The child's stdin is watched here too. Node rethrows an `error` event nobody listens to as an
 * uncaught exception, and a write to a pipe the App Server has already closed — or one it left
 * behind when it died, before Node has processed the exit — raises exactly that on stdin. Listening
 * makes a broken pipe fail this session rather than the host and every other session it runs; the
 * two readers cover stdout and stderr the same way.
 */
export const watchProcess = (session: SessionRuntime): void => {
  session.process.stdin.on('error', (cause) => {
    session.fork(
      failUnlessClosed(
        session,
        new AgentError({ category: 'protocol_error', message: 'Codex stdin failed', cause }),
      ),
    )
  })
  session.process.once('error', (cause) => {
    session.fork(
      failSession(
        session,
        new AgentError({ category: 'spawn_failed', message: 'Codex process failed', cause }),
      ),
    )
  })
  session.process.once('exit', (code, signal) => {
    session.fork(
      failUnlessClosed(
        session,
        new AgentError({
          category: 'process_exited',
          message:
            signal === null
              ? `Codex process exited with ${String(code)}`
              : `Codex process terminated by ${signal}`,
        }),
      ),
    )
  })
}

/**
 * Emits a client-side event. Identity carried by the message that provoked it wins over
 * connection state, which lags whenever a message arrives before the response that would set it.
 */
export const emitEvent = (
  session: SessionRuntime,
  event: string,
  message: string | null,
  carried: ProtocolIdentity = { threadId: null, turnId: null },
  turnStatus: string | null = null,
  lifecycle: AgentLifecycle | null = null,
): Effect.Effect<void> => {
  const carriedThreadId = Option.fromNullable(carried.threadId)
  const carriedTurnId = Option.fromNullable(carried.turnId)
  return Effect.all([Ref.get(session.state), currentInstant]).pipe(
    Effect.tap(([state, timestamp]) =>
      Effect.sync(() => {
        session.onEvent(
          sessionEvent(state, {
            event,
            timestamp,
            processId: processIdOf(session),
            message: message === null ? null : boundedMessage(message, session.knownSecretValues),
            usage: null,
            rateLimits: null,
            threadId: carriedThreadId.pipe(Option.orElse(() => state.threadId)),
            turnId: carriedTurnId.pipe(Option.orElse(() => state.turnId)),
            turnStatus,
            lifecycle,
            payload: clientPayload(event, message, session.redact),
          }),
        )
      }),
    ),
    Effect.asVoid,
  )
}

/**
 * Writes one protocol message to the child, unless the session is over. A session that has failed
 * is one whose process exited, or whose pipes broke, so nothing is left to read the message: a
 * write attempted anyway could only fail the same way again.
 */
export const writeMessage = (session: SessionRuntime, message: JsonObject): Effect.Effect<void> =>
  Ref.get(session.state).pipe(
    Effect.flatMap((state) =>
      state.closed || Option.isSome(state.terminalError)
        ? Effect.void
        : Effect.sync(() => {
            session.process.stdin.write(`${JSON.stringify(message)}\n`)
          }),
    ),
  )

export const notifySession = (
  session: SessionRuntime,
  method: string,
  params: JsonObject,
): Effect.Effect<void> => writeMessage(session, { method, params })

/** Registers the pending entry before writing, so a response can never arrive unowned. */
export const sendRequest = (
  session: SessionRuntime,
  method: string,
  params: JsonObject,
  turnCount: Option.Option<number> = Option.none(),
): Effect.Effect<JsonValue, AgentError> =>
  Effect.gen(function* () {
    const reply = yield* Deferred.make<JsonValue, AgentError>()
    const registered = yield* registerRequest(session.state, method, turnCount, reply)
    if (registered._tag === 'error') {
      return yield* Effect.fail(registered.error)
    }
    const id = registered.id
    yield* writeMessage(session, { id, method, params })
    const response = yield* Deferred.await(reply).pipe(Effect.timeoutOption(session.readTimeoutMs))
    return yield* Option.match(response, {
      onNone: () =>
        expirePendingRequest(
          session,
          id,
          reply,
          new AgentError({
            category: 'read_timeout',
            message: `${method} response timed out`,
          }),
        ),
      onSome: Effect.succeed,
    })
  })

export const expirePendingRequest = (
  session: SessionRuntime,
  id: number,
  reply: Deferred.Deferred<JsonValue, AgentError>,
  error: AgentError,
): Effect.Effect<JsonValue, AgentError> =>
  expirePending(session.state, id, reply).pipe(
    Effect.flatMap((expired) =>
      expired
        ? Deferred.fail(reply, error).pipe(Effect.zipRight(Deferred.await(reply)))
        : Deferred.await(reply),
    ),
  )

/**
 * Records the session-level reason and settles everything still outstanding. Turns that already
 * settled keep their own result — a claimed turn is left alone — so finished work is never
 * relabelled as a session failure.
 */
export const failSession = (
  session: SessionRuntime,
  error: AgentError,
  remember = true,
): Effect.Effect<void> =>
  session.lifecycle.withPermits(1)(
    Effect.gen(function* () {
      const settlement = yield* Deferred.make<void, AgentError>()
      const activity = yield* Queue.dropping<void>(1)
      const candidate: TurnState = {
        settlement,
        activity,
        timerStarted: false,
        claimed: true,
      }
      const outstanding = yield* claimOutstanding(session.state, error, remember, candidate)
      yield* Effect.all(
        [
          ...outstanding.pending.map((request) =>
            Deferred.fail(request.reply, error).pipe(Effect.asVoid),
          ),
          ...outstanding.turns.map(([id, turn]) =>
            Deferred.fail(turn.settlement, error).pipe(
              Effect.tap((won) =>
                won
                  ? emitEvent(
                      session,
                      'turn/terminated',
                      null,
                      { threadId: null, turnId: id },
                      'failed',
                      {
                        phase: 'turn_settled',
                        outcome: codexTurnOutcome('failed'),
                      },
                    )
                  : Effect.void,
              ),
              Effect.asVoid,
            ),
          ),
        ],
        { concurrency: 'unbounded', discard: true },
      )
    }),
  )

export const failUnlessClosed = (session: SessionRuntime, error: AgentError): Effect.Effect<void> =>
  Ref.get(session.state).pipe(
    Effect.flatMap((state) => (state.closed ? Effect.void : failSession(session, error))),
  )
