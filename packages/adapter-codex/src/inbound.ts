import { Deferred, Effect, Option, Ref } from 'effect'

import type { JsonObject } from '@sloppenheimer/core/domain/domain.js'
import { AgentError } from '@sloppenheimer/core/domain/errors.js'
import { currentInstant } from '@sloppenheimer/core/support/clock.js'
import { isJsonObject, isJsonValue } from '@sloppenheimer/core/support/json.js'
import type { AgentLifecycle, TokenCounts } from '@sloppenheimer/core/telemetry.js'
import {
  accumulateUsage,
  admitRateLimits,
  adoptIdentity,
  claimResponse,
  claimTurn,
  noteTurnActivity,
  pendingTurnStartCount,
  removePending,
  type TurnState,
} from './connection-state.js'
import { sessionEvent } from './events.js'
import { notificationFacts, terminalSettlement } from './notifications.js'
import { normalizePayload } from './payload.js'
import { traceObservation } from './trace.js'
import {
  notificationIdentity,
  protocolErrorMessage,
  responseIdentity,
  type ProtocolIdentity,
} from './protocol.js'
import {
  isApprovalRequest,
  isPermissionsApproval,
  isUserInputRequest,
  runHostTool,
  withheldPermissionsGrant,
} from './server-requests.js'
import { boundedMessage, codexTurnOutcome, messageFrom } from './session.js'
import { emitEvent, processIdOf, writeMessage, type SessionRuntime } from './session-runtime.js'
import { completeTurn, ensureTurnStarted, failCurrentTurn, turnStateOf } from './turns.js'

/**
 * Everything the App Server sends: a response to something Sloppenheimer asked, a request Sloppenheimer must
 * answer, or a notification about the thread or a turn.
 *
 * The dispatch is `receiveLine`, and every handler below is reached from it.
 */

export const receiveLine = (
  session: SessionRuntime,
  line: string,
): Effect.Effect<void, AgentError> =>
  Ref.get(session.state).pipe(
    Effect.flatMap((state) => {
      if (state.closed || line.trim().length === 0) {
        return Effect.void
      }
      let decoded: unknown
      try {
        decoded = JSON.parse(line) as unknown
      } catch {
        return emitEvent(session, 'malformed', 'Codex emitted malformed JSON')
      }
      if (!isJsonValue(decoded) || !isJsonObject(decoded)) {
        return emitEvent(session, 'malformed', 'Codex emitted a non-object protocol message')
      }
      const parsed = decoded
      const id = parsed['id']
      const method = parsed['method']
      if (
        typeof id === 'number' &&
        typeof method !== 'string' &&
        (parsed['result'] !== undefined || parsed['error'] !== undefined)
      ) {
        return settleResponse(session, id, parsed)
      }
      if (typeof method !== 'string') {
        return emitEvent(
          session,
          'malformed',
          'Codex emitted a message with no method or response payload',
        )
      }
      if (typeof id === 'string' || typeof id === 'number') {
        return handleServerRequest(session, id, method, parsed)
      }
      return handleNotification(session, method, parsed)
    }),
  )

export const settleResponse = (
  session: SessionRuntime,
  id: number,
  parsed: JsonObject,
): Effect.Effect<void, AgentError> =>
  session.lifecycle.withPermits(1)(
    claimResponse(session.state, id).pipe(
      Effect.flatMap((request) => {
        if (request === undefined) {
          // Response-shaped, but it answers nothing Sloppenheimer sent. It is not progress, so it must not
          // re-arm the turn: a stuck server could otherwise hold a turn open with unmatched ids.
          return emitEvent(
            session,
            'unmatched_response',
            `no pending request for response id ${String(id)}`,
          )
        }
        const error = parsed['error']
        if (error !== undefined) {
          return Deferred.fail(
            request.reply,
            new AgentError({
              category: 'protocol_error',
              message: boundedMessage(protocolErrorMessage(error), session.knownSecretValues),
            }),
          ).pipe(Effect.zipRight(removePending(session.state, id, request.reply)), Effect.asVoid)
        }
        const result = parsed['result']
        if (result === undefined) {
          return Deferred.fail(
            request.reply,
            new AgentError({ category: 'protocol_error', message: 'response has no result' }),
          ).pipe(Effect.zipRight(removePending(session.state, id, request.reply)), Effect.asVoid)
        }
        // Identity is adopted *while settling the response*, not in the awaiting continuation.
        // The App Server may batch a `turn/start` response and the notifications it triggers into
        // one stdout chunk; those notifications are dispatched synchronously by the line reader,
        // long before any `await` resumes, so an id adopted by the awaiter would arrive too late
        // and every batched notification would report the previous turn — or none at all.
        return adoptIdentity(session.state, responseIdentity(result)).pipe(
          Effect.flatMap((identity) => {
            const turnCount = request.turnCount
            const events =
              request.method === 'thread/start'
                ? Option.match(identity.threadId, {
                    onNone: () => Effect.void,
                    onSome: () =>
                      emitEvent(session, 'thread_started', null).pipe(
                        Effect.zipRight(
                          emitEvent(session, 'session_started', null, undefined, null, {
                            phase: 'session_started',
                          }),
                        ),
                      ),
                  })
                : Effect.void
            const turnStarted =
              request.method === 'turn/start' && Option.isSome(turnCount)
                ? Option.match(identity.turnId, {
                    onNone: () => Effect.void,
                    onSome: (turnId) =>
                      turnStateOf(session, turnId).pipe(
                        Effect.zipRight(
                          ensureTurnStarted(session, turnId, turnCount.value, identity.threadId),
                        ),
                      ),
                  })
                : Effect.void
            return events.pipe(
              Effect.zipRight(turnStarted),
              Effect.zipRight(Deferred.succeed(request.reply, result)),
              Effect.zipRight(removePending(session.state, id, request.reply)),
              Effect.asVoid,
            )
          }),
        )
      }),
    ),
  )

/** `id` is echoed back in whichever form the server sent it. */
export const handleServerRequest = (
  session: SessionRuntime,
  id: string | number,
  method: string,
  message: JsonObject,
): Effect.Effect<void> => {
  // A server request declares its own thread and turn, so its events are attributed from the
  // request rather than from connection state, which is null on the first turn and names the
  // previous one afterwards.
  const identity = notificationIdentity(message)
  const turnId = Option.fromNullable(identity.turnId)
  // Only when the request names its turn; an unattributed one is not evidence that turn is alive.
  const noteActivity = Option.match(turnId, {
    onNone: () => Effect.void,
    onSome: (id) => noteTurnActivity(session.state, id),
  })
  if (isPermissionsApproval(method)) {
    return noteActivity.pipe(
      Effect.zipRight(writeMessage(session, { id, result: withheldPermissionsGrant })),
      Effect.zipRight(emitEvent(session, 'permissions_grant_withheld', method, identity)),
    )
  }
  if (isApprovalRequest(method)) {
    return noteActivity.pipe(
      Effect.zipRight(writeMessage(session, { id, result: { decision: 'acceptForSession' } })),
      Effect.zipRight(emitEvent(session, 'approval_auto_approved', method, identity)),
    )
  }
  if (isUserInputRequest(method)) {
    return noteActivity.pipe(
      Effect.zipRight(
        writeMessage(session, {
          id,
          error: { code: -32000, message: 'Sloppenheimer does not support interactive input' },
        }),
      ),
      Effect.zipRight(
        failCurrentTurn(
          session,
          new AgentError({
            category: 'input_required',
            message: 'Codex requested interactive input',
          }),
          turnId,
        ),
      ),
    )
  }
  if (method === 'item/tool/call') {
    session.fork(handleHostToolCall(session, id, message, identity))
    return noteActivity
  }
  return noteActivity.pipe(
    Effect.zipRight(
      writeMessage(session, {
        id,
        error: { code: -32601, message: `Unsupported client request: ${method}` },
      }),
    ),
    Effect.zipRight(emitEvent(session, 'unsupported_tool_call', method, identity)),
  )
}

export const handleHostToolCall = (
  session: SessionRuntime,
  id: string | number,
  message: JsonObject,
  identity: ProtocolIdentity,
): Effect.Effect<void> =>
  runHostTool(message, session.hostTools).pipe(
    Effect.flatMap(({ tool, result }) =>
      writeMessage(session, {
        id,
        result: {
          success: result.success,
          contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
        },
      }).pipe(
        Effect.zipRight(
          emitEvent(
            session,
            result.success ? 'host_tool_succeeded' : 'host_tool_failed',
            tool,
            identity,
          ),
        ),
      ),
    ),
  )

/**
 * Handles one notification: it settles a turn, carries telemetry, or both.
 *
 * A terminal notification claims the turn before any side effect of the notification runs, so a
 * concurrent session failure either won outright or cannot overturn what is reported here.
 */
export const handleNotification = (
  session: SessionRuntime,
  method: string,
  message: JsonObject,
): Effect.Effect<void, AgentError> =>
  Effect.gen(function* () {
    const facts = notificationFacts(method, message)
    const turn = facts.turn
    let reportedTurn = Option.none<TurnState>()
    if (facts.isTerminal && Option.isSome(turn)) {
      const candidate = yield* turnStateOf(session, turn.value.id)
      if (!(yield* claimTurn(session.state, turn.value.id, candidate))) {
        return
      }
      reportedTurn = Option.some(candidate)
    }
    const rateLimits = yield* publishableRateLimits(session, facts.rateLimits)
    let state = yield* Ref.get(session.state)
    const threadId = facts.threadId.pipe(Option.orElse(() => state.threadId))
    const turnId = facts.turnId.pipe(
      Option.orElse(() => facts.parsedTurnId),
      Option.orElse(() => state.turnId),
    )
    const pendingTurnCount = pendingTurnStartCount(state)
    if (Option.isSome(turnId) && Option.isSome(pendingTurnCount)) {
      yield* turnStateOf(session, turnId.value)
      yield* ensureTurnStarted(session, turnId.value, pendingTurnCount.value, threadId)
    }
    const usage = yield* sessionUsage(session, method, turnId, facts.usage)
    yield* Option.match(facts.turnId.pipe(Option.orElse(() => facts.parsedTurnId)), {
      onNone: () => Effect.void,
      onSome: (id) => noteTurnActivity(session.state, id),
    })
    state = yield* Ref.get(session.state)
    session.onEvent(
      sessionEvent(state, {
        event: method,
        timestamp: yield* currentInstant,
        processId: processIdOf(session),
        message: messageFrom(message, session.knownSecretValues),
        usage: Option.getOrNull(usage),
        rateLimits: Option.getOrNull(rateLimits),
        threadId,
        turnId,
        turnStatus: Option.getOrNull(facts.terminalStatus),
        payload: normalizePayload(method, message['params'], session.redact),
        // The same message at full fidelity, for the durable trace. Built in this pass rather than
        // in a second one: two readings of one message must never be able to disagree.
        trace: traceObservation(
          method,
          message['params'],
          session.traceCapture,
          session.redact,
        ),
        // A turn settles when a terminal notification carries the status that says how. Reporting
        // the outcome here is what lets the runtime react without reading Codex's vocabulary.
        lifecycle: Option.match(facts.terminalStatus, {
          onNone: (): AgentLifecycle | null => null,
          onSome: (status): AgentLifecycle => ({
            phase: 'turn_settled',
            outcome: codexTurnOutcome(status),
          }),
        }),
      }),
    )
    if (!facts.isTerminal || Option.isNone(turn) || Option.isNone(reportedTurn)) {
      return
    }
    if (Option.isNone(Option.fromNullable(turn.value.status)) && method === 'turn/completed') {
      yield* emitEvent(session, 'malformed', `${method} for turn ${turn.value.id} omitted status`)
    }
    yield* completeTurn(
      reportedTurn.value,
      terminalSettlement(
        turn.value.id,
        Option.getOrElse(facts.terminalStatus, () => 'unreported'),
      ),
    )
  })

/**
 * A rate-limit reading, if it may be published yet. A sparse notification that arrives before the
 * full snapshot has been read is held instead, so no partial reading is ever shown as the whole.
 */
export const publishableRateLimits = (
  session: SessionRuntime,
  rateLimits: Option.Option<JsonObject>,
): Effect.Effect<Option.Option<JsonObject>> =>
  Option.match(rateLimits, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (reading) =>
      admitRateLimits(session.state, reading).pipe(
        Effect.map((ready) => (ready ? Option.some(reading) : Option.none())),
      ),
  })

export const sessionUsage = (
  session: SessionRuntime,
  method: string,
  turnId: Option.Option<string>,
  usage: Option.Option<TokenCounts>,
): Effect.Effect<Option.Option<TokenCounts>> => {
  if (method !== 'turn/usage' || Option.isNone(usage) || Option.isNone(turnId)) {
    return Effect.succeed(usage)
  }
  return accumulateUsage(session.state, turnId.value, usage.value).pipe(Effect.map(Option.some))
}
