import { Deferred, Effect, Option, Queue, Ref } from 'effect'

import { AgentError } from '@sloppenheimer/core/domain/errors.js'
import {
  beginTurnTimer,
  claimTurn,
  markTurnStarted,
  releaseTurnTimer,
  selectTurn,
  type TurnSettlement,
  type TurnState,
} from './connection-state.js'
import { codexTurnOutcome } from './session.js'
import { emitEvent, failSession, type SessionRuntime } from './session-runtime.js'

/**
 * The turn lifecycle: finding a turn's Deferred, settling it exactly once, and the silence timer
 * that fails one that has stopped producing output.
 */

/** Finds or installs a turn's Deferred, failing if the session has already ended. */
export const turnStateOf = (
  session: SessionRuntime,
  turnId: string,
): Effect.Effect<TurnState, AgentError> =>
  Effect.gen(function* () {
    const settlement = yield* Deferred.make<void, AgentError>()
    const activity = yield* Queue.dropping<void>(1)
    const selected = yield* selectTurn(session.state, turnId, {
      settlement,
      activity,
      timerStarted: false,
      claimed: false,
    })
    if (selected._tag === 'error') {
      return yield* Effect.fail(selected.error)
    }
    return selected.turn
  })

/**
 * Completes the turn exactly once. Deferred completion reports whether this call won, which
 * keeps a later lifecycle notification or session failure from overturning the first result.
 */
export const settleTurn = (
  session: SessionRuntime,
  turnId: string,
  settlement: TurnSettlement,
  reported = false,
): Effect.Effect<boolean> =>
  turnStateOf(session, turnId).pipe(
    Effect.flatMap((turn) =>
      claimTurn(session.state, turnId, turn).pipe(
        Effect.flatMap((claimed) =>
          claimed ? completeTurn(turn, settlement).pipe(Effect.as(true)) : Effect.succeed(false),
        ),
      ),
    ),
    Effect.tap((won) => {
      if (!won || reported) {
        return Effect.void
      }
      const status =
        settlement._tag === 'completed'
          ? 'completed'
          : settlement.error.category === 'turn_timeout'
            ? 'timed_out'
            : 'failed'
      return emitEvent(session, 'turn/terminated', null, { threadId: null, turnId }, status, {
        phase: 'turn_settled',
        outcome: codexTurnOutcome(status),
      })
    }),
    Effect.catchAll(() => Effect.succeed(false)),
  )

export const completeTurn = (turn: TurnState, settlement: TurnSettlement): Effect.Effect<void> =>
  (settlement._tag === 'completed'
    ? Deferred.succeed(turn.settlement, undefined)
    : Deferred.fail(turn.settlement, settlement.error)
  ).pipe(Effect.asVoid)

export const failCurrentTurn = (
  session: SessionRuntime,
  error: AgentError,
  turnId: Option.Option<string>,
): Effect.Effect<void> =>
  Ref.get(session.state).pipe(
    Effect.flatMap((state) => {
      const target = turnId.pipe(Option.orElse(() => state.turnId))
      return Option.match(target, {
        onNone: () => failSession(session, error),
        onSome: (id) => settleTurn(session, id, { _tag: 'failed', error }).pipe(Effect.asVoid),
      })
    }),
  )

export const startTurnTimer = (
  session: SessionRuntime,
  turnId: string,
  turn: TurnState,
): Effect.Effect<void> =>
  beginTurnTimer(session.state, turnId, turn).pipe(
    Effect.tap((start) => {
      if (!start) {
        return Effect.void
      }
      const awaitActivity = (): Effect.Effect<void> =>
        Queue.take(turn.activity).pipe(
          Effect.timeoutOption(session.turnTimeoutMs),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                settleTurn(session, turnId, {
                  _tag: 'failed',
                  error: new AgentError({
                    category: 'turn_timeout',
                    message: `turn ${turnId} produced no output for ${String(session.turnTimeoutMs)}ms`,
                  }),
                }).pipe(Effect.asVoid),
              onSome: () => awaitActivity(),
            }),
          ),
        )
      session.fork(
        Effect.raceFirst(Deferred.await(turn.settlement).pipe(Effect.ignore), awaitActivity()).pipe(
          Effect.ensuring(releaseTurnTimer(session.state, turnId, turn)),
        ),
      )
      return Effect.void
    }),
    Effect.asVoid,
  )

export const ensureTurnStarted = (
  session: SessionRuntime,
  turnId: string,
  turnCount: number,
  threadId: Option.Option<string>,
): Effect.Effect<void> =>
  markTurnStarted(session.state, turnId, turnCount).pipe(
    Effect.flatMap((started) =>
      started
        ? emitEvent(
            session,
            'turn_started',
            null,
            { threadId: Option.getOrNull(threadId), turnId },
            null,
            {
              phase: 'turn_started',
            },
          )
        : Effect.void,
    ),
  )

/**
 * Waits for a turn to finish. Everything that could have decided it already — a completion the
 * App Server emitted in the same batch as the `turn/start` response, a request Sloppenheimer could not
 * serve, a process that died — is the same Deferred, so this never has to rank one against
 * another. A Deferred retains its result for late waiters.
 */
export const awaitTurn = (
  session: SessionRuntime,
  turnId: string,
): Effect.Effect<void, AgentError> =>
  turnStateOf(session, turnId).pipe(
    Effect.tap((turn) => startTurnTimer(session, turnId, turn)),
    Effect.flatMap((turn) => Deferred.await(turn.settlement)),
  )
