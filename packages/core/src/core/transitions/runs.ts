import { Option } from 'effect'

import type { IssueId, JsonObject } from '../../domain/domain.js'
import { withEntry, withoutEntry } from '../../support/collections.js'
import { mergeSparseObject } from '../../support/json.js'
import { foldTurnIdentity, type AgentEvent } from '../../telemetry.js'
import type { RunningEntry, RuntimeState } from '../state.js'

/**
 * The live runs, and the telemetry the runner's callback buffers for them. A run is identified by
 * when it started rather than by its issue, so an event from a superseded run can never be applied
 * to the run that replaced it.
 */

export const beginRun = (state: RuntimeState, entry: RunningEntry): RuntimeState => ({
  ...state,
  running: withEntry(state.running, entry.issue.id, entry),
})

/** Reserves the next run identifier. A run is identified by when it started, never by its issue. */
export const takeRunId = (state: RuntimeState): readonly [number, RuntimeState] => [
  state.nextRunId,
  { ...state, nextRunId: state.nextRunId + 1 },
]

/**
 * Removes a run, but only the run the caller means. A `WorkerExited` for a superseded run must not
 * end the run that replaced it, which is what the expected identifier guards.
 */
export const endRun = (
  state: RuntimeState,
  id: IssueId,
  expectedRunId: number | null,
): readonly [Option.Option<RunningEntry>, RuntimeState] => {
  const entry = state.running.get(id)
  if (entry === undefined || (expectedRunId !== null && entry.runId !== expectedRunId)) {
    return [Option.none(), state]
  }
  return [Option.some(entry), { ...state, running: withoutEntry(state.running, id) }]
}

/** Replaces a live run's entry, if the run is still the one the caller read. */
export const updateRun = (
  state: RuntimeState,
  id: IssueId,
  update: (entry: RunningEntry) => RunningEntry,
): RuntimeState => {
  const entry = state.running.get(id)
  if (entry === undefined) {
    return state
  }
  return { ...state, running: withEntry(state.running, id, update(entry)) }
}

/** Folds an ended run's tokens and wall time into the lifetime totals. */
export const accountEndedRun = (
  state: RuntimeState,
  entry: RunningEntry,
  now: number,
): RuntimeState => ({
  ...state,
  totals: {
    inputTokens: state.totals.inputTokens + entry.tokens.inputTokens,
    outputTokens: state.totals.outputTokens + entry.tokens.outputTokens,
    totalTokens: state.totals.totalTokens + entry.tokens.totalTokens,
    secondsRunning:
      state.totals.secondsRunning + Math.max(now - entry.startedAt.getTime(), 0) / 1_000,
  },
})

/**
 * Applies one protocol event to the run it belongs to. Pure in the entry alone: the logging the
 * event also deserves is the caller's, because what to say depends on what changed here.
 */
export const applyRunEvent = (entry: RunningEntry, update: AgentEvent): RunningEntry => ({
  ...entry,
  lastEvent: update.event,
  lastEventAt: update.timestamp,
  lastMessage: update.message ?? entry.lastMessage,
  processId: update.processId,
  threadId: update.threadId ?? entry.threadId,
  // Shared with the agent detail, so a late event from a superseded turn can never leave the two
  // surfaces reporting different turns — or an older turn's session id beside a newer turn number.
  ...foldTurnIdentity(entry, update),
})

/**
 * Records that the host's postflight has taken this run over from the agent.
 *
 * Only the run the event names: a late marker from a superseded turn must not exempt the run that
 * replaced it from the stall timer.
 */
export const notePostflightStarted = (
  state: RuntimeState,
  id: IssueId,
  runId: number,
  at: Date,
): RuntimeState => {
  const entry = state.running.get(id)
  if (entry === undefined || entry.runId !== runId || entry.postflightStartedAt !== null) {
    return state
  }
  return {
    ...state,
    running: withEntry(state.running, id, { ...entry, postflightStartedAt: at }),
  }
}

/**
 * Settles the telemetry the runner's callback buffered for a run that is ending. The usage counters
 * only ever rise, so a late report cannot lower what the run already accounted for.
 */
export const applyPendingTelemetry = (
  state: RuntimeState,
  id: IssueId,
  entry: RunningEntry,
): readonly [RunningEntry, RuntimeState] => {
  const usage = state.pendingUsage.get(id)
  const settled: RunningEntry =
    usage === undefined
      ? entry
      : {
          ...entry,
          lastReportedTokens: usage,
          tokens: {
            inputTokens: Math.max(entry.tokens.inputTokens, usage.inputTokens),
            outputTokens: Math.max(entry.tokens.outputTokens, usage.outputTokens),
            totalTokens: Math.max(entry.tokens.totalTokens, usage.totalTokens),
          },
        }
  return [
    settled,
    {
      ...state,
      rateLimits:
        state.pendingRateLimits === null
          ? state.rateLimits
          : mergeSparseObject(state.rateLimits, state.pendingRateLimits),
      pendingRateLimits: null,
      pendingUsage: withoutEntry(state.pendingUsage, id),
    },
  ]
}

export const recordPendingUsage = (
  state: RuntimeState,
  id: IssueId,
  usage: NonNullable<AgentEvent['usage']>,
): RuntimeState => {
  const previous = state.pendingUsage.get(id)
  return {
    ...state,
    pendingUsage: withEntry(state.pendingUsage, id, {
      inputTokens: Math.max(previous?.inputTokens ?? 0, usage.inputTokens),
      outputTokens: Math.max(previous?.outputTokens ?? 0, usage.outputTokens),
      totalTokens: Math.max(previous?.totalTokens ?? 0, usage.totalTokens),
    }),
  }
}

export const recordPendingRateLimits = (
  state: RuntimeState,
  rateLimits: JsonObject,
): RuntimeState => ({
  ...state,
  pendingRateLimits: mergeSparseObject(state.pendingRateLimits, rateLimits),
})

export const queuePendingLifecycle = (
  state: RuntimeState,
  id: IssueId,
  update: AgentEvent,
): RuntimeState => ({
  ...state,
  pendingLifecycle: withEntry(state.pendingLifecycle, id, [
    ...(state.pendingLifecycle.get(id) ?? []),
    update,
  ]),
})

/** Drops one queued lifecycle event once the mailbox has applied it. */
export const dropPendingLifecycle = (
  state: RuntimeState,
  id: IssueId,
  update: AgentEvent,
): RuntimeState => {
  const queued = state.pendingLifecycle.get(id)
  if (queued === undefined) {
    return state
  }
  const index = queued.indexOf(update)
  if (index < 0) {
    return state
  }
  const remaining = [...queued.slice(0, index), ...queued.slice(index + 1)]
  return {
    ...state,
    pendingLifecycle:
      remaining.length === 0
        ? withoutEntry(state.pendingLifecycle, id)
        : withEntry(state.pendingLifecycle, id, remaining),
  }
}

export const takePendingLifecycle = (
  state: RuntimeState,
  id: IssueId,
): readonly [readonly AgentEvent[], RuntimeState] => [
  state.pendingLifecycle.get(id) ?? [],
  { ...state, pendingLifecycle: withoutEntry(state.pendingLifecycle, id) },
]

export const clearPendingRateLimits = (state: RuntimeState, observed: JsonObject): RuntimeState =>
  state.pendingRateLimits === observed ? { ...state, pendingRateLimits: null } : state

export const mergeRateLimits = (state: RuntimeState, rateLimits: JsonObject): RuntimeState => ({
  ...state,
  rateLimits: mergeSparseObject(state.rateLimits, rateLimits),
})
