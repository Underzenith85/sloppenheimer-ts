import type { Deferred } from 'effect'

import type { EffectiveWorkflow, RefreshOperation, RuntimeState } from '../state.js'

/**
 * The polling cadence — the tick debounce and the callers waiting on a refresh — and the workflow
 * currently in force, which every pass may replace. The interval timer itself is a fiber, owned by
 * `runtime/execution.ts` rather than recorded here.
 */

export type TickSource = 'startup' | 'timer' | 'change'

/**
 * The tick debounce, in one place. A tick already queued absorbs any further request; a change that
 * lands while a poll is running additionally owes that poll a follow-up pass, because the poll has
 * already read the state the change invalidated.
 *
 * `enqueue` is whether the caller must offer a `Tick` to the mailbox. `scheduled` is whether this
 * request is the one that brought a pass into being — by enqueueing the tick, or by being the
 * change that first asked the running poll for a follow-up. A request that only joins a pass
 * somebody else already arranged is neither, and a refresh acknowledgement calls that coalesced.
 */
export const requestTick = (
  state: RuntimeState,
  source: TickSource,
): readonly [Readonly<{ enqueue: boolean; scheduled: boolean }>, RuntimeState] => {
  if (state.tickQueued) {
    const owesFollowUp = state.pollRunning && source === 'change'
    return [
      { enqueue: false, scheduled: owesFollowUp && !state.followUpRequested },
      owesFollowUp ? { ...state, followUpRequested: true } : state,
    ]
  }
  return [
    { enqueue: true, scheduled: true },
    { ...state, tickQueued: true },
  ]
}

export const beginPoll = (state: RuntimeState): RuntimeState => ({ ...state, pollRunning: true })

/**
 * Closes a poll. A follow-up that was requested during it turns straight into the next tick, which
 * is why the queued flag survives; otherwise the queue drains and the interval timer takes over.
 */
export const finishPoll = (
  state: RuntimeState,
): readonly [Readonly<{ followUp: boolean }>, RuntimeState] => {
  if (state.followUpRequested) {
    return [{ followUp: true }, { ...state, followUpRequested: false, pollRunning: false }]
  }
  return [{ followUp: false }, { ...state, pollRunning: false, tickQueued: false }]
}

/**
 * Records a caller waiting on a refresh. A request that arrives while a poll is running waits for
 * the *next* poll: the running one has already read the state the caller wants re-read.
 */
export const awaitRefresh = (
  state: RuntimeState,
  reply: Deferred.Deferred<readonly RefreshOperation[]>,
): RuntimeState =>
  state.pollRunning
    ? { ...state, nextRefreshWaiters: [...state.nextRefreshWaiters, reply] }
    : { ...state, currentRefreshWaiters: [...state.currentRefreshWaiters, reply] }

/** Takes the waiters the finished poll satisfied. */
export const takeRefreshWaiters = (
  state: RuntimeState,
): readonly [readonly Deferred.Deferred<readonly RefreshOperation[]>[], RuntimeState] => [
  state.currentRefreshWaiters,
  { ...state, currentRefreshWaiters: [] },
]

/** A follow-up pass adopts the callers that were waiting for it. */
export const promoteRefreshWaiters = (state: RuntimeState): RuntimeState => ({
  ...state,
  currentRefreshWaiters: [...state.currentRefreshWaiters, ...state.nextRefreshWaiters],
  nextRefreshWaiters: [],
})

/** The workflow the orchestrator is running under, and the reason a reload was refused. */
export const adoptWorkflow = (state: RuntimeState, effective: EffectiveWorkflow): RuntimeState => ({
  ...state,
  lastKnownGood: effective,
})

export const setWorkflowReloadError = (
  state: RuntimeState,
  error: RuntimeState['workflowReloadError'],
): RuntimeState => ({ ...state, workflowReloadError: error })
