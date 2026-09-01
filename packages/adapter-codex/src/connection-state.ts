import { Deferred, Effect, Option, Queue, Ref } from 'effect'

import type { JsonObject, JsonValue } from '@symphony/core/domain/domain.js'
import type { AgentError } from '@symphony/core/domain/errors.js'
import { mergeSparseObject } from '@symphony/core/support/json.js'
import type { AgentEvent } from '@symphony/core/telemetry.js'
import type { ProtocolIdentity } from './protocol.js'

/**
 * Everything one App Server connection remembers, and every transition of it.
 *
 * The state is a single `Ref`, and each transition below is one atomic `Ref.modify` reporting what
 * it decided. Keeping them here rather than inline in the connection is what makes each decision
 * readable as a decision: whether this caller won the turn, whether the response it holds is still
 * owned, whether the session had already failed before the request was ever written.
 *
 * Nothing here writes to the process, emits an event, or fails an effect. A transition that a
 * caller must react to reports that in its result.
 */

export type PendingRequest = Readonly<{
  method: string
  turnCount: Option.Option<number>
  reply: Deferred.Deferred<JsonValue, AgentError>
  claimed: boolean
}>

export type TurnState = Readonly<{
  settlement: Deferred.Deferred<void, AgentError>
  activity: Queue.Queue<void>
  timerStarted: boolean
  claimed: boolean
}>

export type TurnSettlement =
  | Readonly<{ _tag: 'completed' }>
  | Readonly<{ _tag: 'failed'; error: AgentError }>

export type TurnSelection =
  | Readonly<{ _tag: 'turn'; turn: TurnState }>
  | Readonly<{ _tag: 'error'; error: AgentError }>

export type RequestRegistration =
  | Readonly<{ _tag: 'registered'; id: number }>
  | Readonly<{ _tag: 'error'; error: AgentError }>

export type ConnectionState = Readonly<{
  pending: ReadonlyMap<number, PendingRequest>
  turns: ReadonlyMap<string, TurnState>
  turnUsage: ReadonlyMap<string, NonNullable<AgentEvent['usage']>>
  startedTurns: ReadonlySet<string>
  turnCounts: ReadonlyMap<string, number>
  pendingRateLimits: Option.Option<JsonObject>
  rateLimitsReady: boolean
  nextId: number
  closed: boolean
  terminalError: Option.Option<AgentError>
  threadId: Option.Option<string>
  turnId: Option.Option<string>
  turnCount: number
}>

/** The `Ref` every transition below takes. */
export type ConnectionStateRef = Ref.Ref<ConnectionState>

export const initialConnectionState: ConnectionState = {
  pending: new Map(),
  turns: new Map(),
  turnUsage: new Map(),
  startedTurns: new Set(),
  turnCounts: new Map(),
  pendingRateLimits: Option.none(),
  rateLimitsReady: false,
  nextId: 1,
  closed: false,
  terminalError: Option.none(),
  threadId: Option.none(),
  turnId: Option.none(),
  turnCount: 0,
}

/**
 * Chooses atomically between a concurrently installed turn, the session's terminal error, and the
 * caller's candidate. The candidate is allocated outside the update, because allocating a Deferred
 * and a Queue is itself an effect.
 */
export const selectTurn = (
  state: ConnectionStateRef,
  turnId: string,
  candidate: TurnState,
): Effect.Effect<TurnSelection> =>
  Ref.modify(state, (current): readonly [TurnSelection, ConnectionState] => {
    const existing = current.turns.get(turnId)
    if (existing !== undefined) {
      return [{ _tag: 'turn', turn: existing }, current]
    }
    if (Option.isSome(current.terminalError)) {
      return [{ _tag: 'error', error: current.terminalError.value }, current]
    }
    return [
      { _tag: 'turn', turn: candidate },
      { ...current, turns: new Map(current.turns).set(turnId, candidate) },
    ]
  })

/** Claims the right to settle a turn. Exactly one caller is told `true`. */
export const claimTurn = (
  state: ConnectionStateRef,
  turnId: string,
  turn: TurnState,
): Effect.Effect<boolean> =>
  Ref.modify(state, (current) => {
    const existing = current.turns.get(turnId)
    if (existing?.settlement !== turn.settlement || existing.claimed) {
      return [false, current]
    }
    return [
      true,
      { ...current, turns: new Map(current.turns).set(turnId, { ...existing, claimed: true }) },
    ]
  })

/** Claims the right to start a turn's silence timer, which only the first waiter gets. */
export const beginTurnTimer = (
  state: ConnectionStateRef,
  turnId: string,
  turn: TurnState,
): Effect.Effect<boolean> =>
  Ref.modify(state, (current) => {
    const existing = current.turns.get(turnId)
    if (existing !== turn || existing.timerStarted || existing.claimed) {
      return [false, current]
    }
    return [
      true,
      {
        ...current,
        turns: new Map(current.turns).set(turnId, { ...existing, timerStarted: true }),
      },
    ]
  })

/** Releases the timer claim once the timer fiber ends, but only if it is still the same turn. */
export const releaseTurnTimer = (
  state: ConnectionStateRef,
  turnId: string,
  turn: TurnState,
): Effect.Effect<void> =>
  Ref.update(state, (current) => {
    const existing = current.turns.get(turnId)
    if (existing?.activity !== turn.activity || !existing.timerStarted) {
      return current
    }
    return {
      ...current,
      turns: new Map(current.turns).set(turnId, { ...existing, timerStarted: false }),
    }
  })

/**
 * Records progress on a turn whose timer is running. Activity is an edge, not a count: the queue
 * drops what it cannot hold, so a burst re-arms the timer once rather than once per notification.
 */
export const noteTurnActivity = (state: ConnectionStateRef, turnId: string): Effect.Effect<void> =>
  Ref.get(state).pipe(
    Effect.flatMap((current) => {
      const turn = current.turns.get(turnId)
      if (turn?.timerStarted !== true || turn.claimed) {
        return Effect.void
      }
      return Queue.offer(turn.activity, undefined)
    }),
    Effect.asVoid,
  )

/** Takes the next request id and registers the pending entry, unless the session already failed. */
export const registerRequest = (
  state: ConnectionStateRef,
  method: string,
  turnCount: Option.Option<number>,
  reply: Deferred.Deferred<JsonValue, AgentError>,
): Effect.Effect<RequestRegistration> =>
  Ref.modify(state, (current): readonly [RequestRegistration, ConnectionState] => {
    if (Option.isSome(current.terminalError)) {
      return [{ _tag: 'error', error: current.terminalError.value }, current]
    }
    const id = current.nextId
    return [
      { _tag: 'registered', id },
      {
        ...current,
        nextId: id + 1,
        pending: new Map(current.pending).set(id, { method, turnCount, reply, claimed: false }),
      },
    ]
  })

/** Claims a response for the request that is still waiting on it, if any caller still is. */
export const claimResponse = (
  state: ConnectionStateRef,
  id: number,
): Effect.Effect<PendingRequest | undefined> =>
  Ref.modify(state, (current) => {
    const request = current.pending.get(id)
    if (request === undefined || request.claimed) {
      return [undefined, current]
    }
    const claimed = { ...request, claimed: true }
    return [claimed, { ...current, pending: new Map(current.pending).set(id, claimed) }]
  })

/** Drops a request that timed out, reporting whether it was this caller that dropped it. */
export const expirePending = (
  state: ConnectionStateRef,
  id: number,
  reply: Deferred.Deferred<JsonValue, AgentError>,
): Effect.Effect<boolean> =>
  Ref.modify(state, (current) => {
    const request = current.pending.get(id)
    if (request?.reply !== reply || request.claimed) {
      return [false, current]
    }
    const pending = new Map(current.pending)
    pending.delete(id)
    return [true, { ...current, pending }]
  })

/** Forgets a settled request, leaving one that was already replaced alone. */
export const removePending = (
  state: ConnectionStateRef,
  id: number,
  reply: Deferred.Deferred<JsonValue, AgentError>,
): Effect.Effect<void> =>
  Ref.update(state, (current) => {
    if (current.pending.get(id)?.reply !== reply) {
      return current
    }
    const pending = new Map(current.pending)
    pending.delete(id)
    return { ...current, pending }
  })

/** Records the thread the App Server issued. */
export const adoptThreadId = (state: ConnectionStateRef, threadId: string): Effect.Effect<void> =>
  Ref.update(state, (current) => ({ ...current, threadId: Option.some(threadId) }))

/**
 * Adopts the thread and turn ids a message declared, keeping what the connection already knew for
 * whichever half the message did not name.
 */
export const adoptIdentity = (
  state: ConnectionStateRef,
  declared: ProtocolIdentity,
): Effect.Effect<Readonly<{ threadId: Option.Option<string>; turnId: Option.Option<string> }>> =>
  Ref.modify(state, (current) => {
    const threadId = Option.orElse(Option.fromNullable(declared.threadId), () => current.threadId)
    const turnId = Option.orElse(Option.fromNullable(declared.turnId), () => current.turnId)
    return [
      { threadId, turnId },
      { ...current, threadId, turnId },
    ]
  })

/** Records a turn as started, reporting whether this is the first caller to say so. */
export const markTurnStarted = (
  state: ConnectionStateRef,
  turnId: string,
  turnCount: number,
): Effect.Effect<boolean> =>
  Ref.modify(state, (current) => {
    if (current.startedTurns.has(turnId)) {
      return [false, current]
    }
    return [
      true,
      {
        ...current,
        startedTurns: new Set(current.startedTurns).add(turnId),
        turnCounts: new Map(current.turnCounts).set(turnId, turnCount),
        turnId: Option.some(turnId),
        turnCount,
      },
    ]
  })

/**
 * Merges the full snapshot the session read at startup with whatever sparse notifications arrived
 * before it, and opens the gate for the ones that arrive afterwards.
 */
export const adoptRateLimitSnapshot = (
  state: ConnectionStateRef,
  snapshot: JsonObject,
): Effect.Effect<JsonObject> =>
  Ref.modify(state, (current) => [
    mergeSparseObject(
      snapshot,
      Option.getOrElse(current.pendingRateLimits, () => ({})),
    ),
    { ...current, pendingRateLimits: Option.none(), rateLimitsReady: true },
  ])

/**
 * Reports whether a sparse rate-limit notification may be published yet. Before the full snapshot
 * has been read it is held instead, so no operator is ever shown a partial reading as the whole.
 */
export const admitRateLimits = (
  state: ConnectionStateRef,
  rateLimits: JsonObject,
): Effect.Effect<boolean> =>
  Ref.modify(state, (current) => {
    if (current.rateLimitsReady) {
      return [true, current]
    }
    return [
      false,
      {
        ...current,
        pendingRateLimits: Option.some(
          mergeSparseObject(
            Option.getOrElse(current.pendingRateLimits, () => ({})),
            rateLimits,
          ),
        ),
      },
    ]
  })

/**
 * Records a turn's usage as the high-water mark of what it has reported, and returns the session
 * total across every turn. Codex re-reports a turn's usage cumulatively, so taking the maximum per
 * field keeps a late, smaller reading from moving the total backwards.
 */
export const accumulateUsage = (
  state: ConnectionStateRef,
  turnId: string,
  usage: NonNullable<AgentEvent['usage']>,
): Effect.Effect<NonNullable<AgentEvent['usage']>> =>
  Ref.modify(state, (current) => {
    const previous = current.turnUsage.get(turnId)
    const turnUsage = new Map(current.turnUsage).set(turnId, {
      inputTokens: Math.max(previous?.inputTokens ?? 0, usage.inputTokens),
      outputTokens: Math.max(previous?.outputTokens ?? 0, usage.outputTokens),
      totalTokens: Math.max(previous?.totalTokens ?? 0, usage.totalTokens),
    })
    const total = [...turnUsage.values()].reduce(
      (sum, entry) => ({
        inputTokens: sum.inputTokens + entry.inputTokens,
        outputTokens: sum.outputTokens + entry.outputTokens,
        totalTokens: sum.totalTokens + entry.totalTokens,
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    )
    return [total, { ...current, turnUsage }]
  })

/** The turn count carried by a `turn/start` that has not been answered yet. */
export const pendingTurnStartCount = (state: ConnectionState): Option.Option<number> =>
  Option.fromNullable(
    [...state.pending.values()].find(
      (pending) => pending.method === 'turn/start' && Option.isSome(pending.turnCount),
    ),
  ).pipe(Option.flatMap((pending) => pending.turnCount))

/** Closes the connection, reporting whether this caller is the one that closed it. */
export const beginClose = (state: ConnectionStateRef): Effect.Effect<boolean> =>
  Ref.modify(state, (current) =>
    current.closed ? [false, current] : [true, { ...current, closed: true }],
  )

/** What a session-terminal failure has left to settle. */
export type Outstanding = Readonly<{
  pending: readonly PendingRequest[]
  turns: readonly (readonly [string, TurnState])[]
}>

/**
 * Records the session-level reason and claims everything still outstanding in the same transition.
 *
 * The candidate stands in for a turn in flight that has no Deferred yet: publishing and claiming it
 * here means a racing response can find it, but no lifecycle notification can win its settlement.
 * Turns that already settled keep their own result, because a claimed turn is left alone.
 */
export const claimOutstanding = (
  state: ConnectionStateRef,
  error: AgentError,
  remember: boolean,
  candidate: TurnState,
): Effect.Effect<Outstanding> =>
  Ref.modify(state, (current) => {
    const turns = new Map(current.turns)
    const claimedTurns: Array<readonly [string, TurnState]> = []
    if (Option.isSome(current.turnId) && !turns.has(current.turnId.value)) {
      turns.set(current.turnId.value, candidate)
      claimedTurns.push([current.turnId.value, candidate])
    }
    for (const [turnId, turn] of turns) {
      if (turn.claimed) {
        continue
      }
      const claimed = { ...turn, claimed: true }
      turns.set(turnId, claimed)
      claimedTurns.push([turnId, claimed])
    }
    return [
      { pending: [...current.pending.values()], turns: claimedTurns },
      {
        ...current,
        pending: new Map(),
        turns,
        terminalError:
          remember && Option.isNone(current.terminalError)
            ? Option.some(error)
            : current.terminalError,
      },
    ]
  })
