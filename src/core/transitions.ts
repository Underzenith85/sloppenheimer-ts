import { Option, type Deferred } from 'effect'

import type { Issue, IssueId, JsonObject } from '../domain/domain.js'
import type { HandoffSnapshot } from '../domain/handoff.js'
import { mergeSparseObject } from '../support/json.js'
import { agentDetailPath, type AgentDetailRecord, type AgentDetailStatus } from '../telemetry.js'
import type { AgentEvent } from '../telemetry.js'
import {
  rememberedIdentifiers,
  retainedCompletedDetails,
  type EffectiveWorkflow,
  type ExecutionSnapshot,
  type HandoffEntry,
  type HandoffRecoveryCounts,
  type CompletedEntry,
  type PendingRetirement,
  type PublishedDetail,
  type RetryEntry,
  type RunningEntry,
  type RuntimeState,
} from './state.js'

/**
 * Every transition the scheduler makes, as a pure function of the state and the thing that
 * happened. No fibers, no ports, no clock: a caller supplies whatever it observed, and gets the
 * next state back.
 *
 * A transition the caller must then act on — a retry fiber to interrupt, a run entry to account for
 * — hands the value back beside the state rather than performing the effect itself, so the decision
 * stays separable from what carries it out. Those return `[value, nextState]`, which is the order
 * `Ref.modify` consumes and so the order a call site can hand straight to the cell. A lookup that
 * may find nothing answers with `Option`, because what it found is what decides the caller's next
 * branch — never with `null`, which this codebase keeps for data that is serialized.
 */

const withEntry = <Key, Value>(
  map: ReadonlyMap<Key, Value>,
  key: Key,
  value: Value,
): ReadonlyMap<Key, Value> => new Map(map).set(key, value)

const withoutEntry = <Key, Value>(
  map: ReadonlyMap<Key, Value>,
  key: Key,
): ReadonlyMap<Key, Value> => {
  if (!map.has(key)) {
    return map
  }
  const next = new Map(map)
  next.delete(key)
  return next
}

const withMember = <Value>(set: ReadonlySet<Value>, value: Value): ReadonlySet<Value> =>
  set.has(value) ? set : new Set(set).add(value)

const withoutMember = <Value>(set: ReadonlySet<Value>, value: Value): ReadonlySet<Value> => {
  if (!set.has(value)) {
    return set
  }
  const next = new Set(set)
  next.delete(value)
  return next
}

/** Drops oldest-first until the collection is within its cap. Insertion order is the age order. */
const capped = <Value>(set: ReadonlySet<Value>, limit: number): ReadonlySet<Value> => {
  if (set.size <= limit) {
    return set
  }
  const next = new Set(set)
  for (const value of set) {
    if (next.size <= limit) {
      break
    }
    next.delete(value)
  }
  return next
}

// ---------------------------------------------------------------------------
// Claim lifecycle
// ---------------------------------------------------------------------------

/**
 * Remembers an issue's identifier so a detail request for it can be answered after its record has
 * gone. Bounded, oldest first.
 */
export const noteIssue = (state: RuntimeState, issue: Issue): RuntimeState => {
  const identifiers = withEntry(state.identifiers, issue.id, issue.identifier)
  if (identifiers.size <= rememberedIdentifiers) {
    return { ...state, identifiers }
  }
  const next = new Map(identifiers)
  const oldest = next.keys().next()
  if (!oldest.done) {
    next.delete(oldest.value)
  }
  return { ...state, identifiers: next }
}

/** Takes responsibility for an issue: nothing else dispatches it while the claim stands. */
export const claimIssue = (state: RuntimeState, issue: Issue): RuntimeState =>
  noteIssue({ ...state, claimed: withMember(state.claimed, issue.id) }, issue)

export const releaseClaim = (state: RuntimeState, id: IssueId): RuntimeState => ({
  ...state,
  claimed: withoutMember(state.claimed, id),
})

/**
 * The issue is finished with: what it finished as is filed, and the claim is given up in the same
 * step. Nothing else may complete an issue while still holding it.
 */
export const completeIssue = (
  state: RuntimeState,
  id: IssueId,
  finished: CompletedEntry,
): RuntimeState => ({
  ...state,
  completed: withEntry(state.completed, id, finished),
  claimed: withoutMember(state.claimed, id),
})

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

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
  turnId:
    update.turnId !== null && update.turnCount >= entry.turnCount ? update.turnId : entry.turnId,
  sessionId: update.sessionId ?? entry.sessionId,
  turnCount: Math.max(entry.turnCount, update.turnCount),
})

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

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

/**
 * Queues a retry, returning whatever it displaced so the caller can interrupt that timer. An issue
 * has at most one pending retry: a newer schedule always wins.
 */
export const scheduleRetry = (
  state: RuntimeState,
  entry: RetryEntry,
): readonly [Option.Option<RetryEntry>, RuntimeState] => {
  const existing = Option.fromNullable(state.retries.get(entry.issue.id))
  const claimed = claimIssue(state, entry.issue)
  return [existing, { ...claimed, retries: withEntry(claimed.retries, entry.issue.id, entry) }]
}

/** Removes a queued retry, returning it so the caller can interrupt its timer. */
export const takeRetry = (
  state: RuntimeState,
  id: IssueId,
): readonly [Option.Option<RetryEntry>, RuntimeState] => {
  const entry = state.retries.get(id)
  if (entry === undefined) {
    return [Option.none(), state]
  }
  return [Option.some(entry), { ...state, retries: withoutEntry(state.retries, id) }]
}

/**
 * Takes a retry only when it is the attempt that came due. A `RetryDue` for a superseded attempt
 * belongs to a timer that has since been replaced, and must not consume the live one.
 */
export const takeDueRetry = (
  state: RuntimeState,
  id: IssueId,
  attempt: number,
): readonly [Option.Option<RetryEntry>, RuntimeState] => {
  const entry = state.retries.get(id)
  if (entry?.attempt !== attempt) {
    return [Option.none(), state]
  }
  return [Option.some(entry), { ...state, retries: withoutEntry(state.retries, id) }]
}

// ---------------------------------------------------------------------------
// Pausing
// ---------------------------------------------------------------------------

export const pauseIssueNumber = (state: RuntimeState, issueNumber: number): RuntimeState => ({
  ...state,
  pausedIssueNumbers: withMember(state.pausedIssueNumbers, issueNumber),
})

export const resumeIssueNumber = (state: RuntimeState, issueNumber: number): RuntimeState => ({
  ...state,
  pausedIssueNumbers: withoutMember(state.pausedIssueNumbers, issueNumber),
})

// ---------------------------------------------------------------------------
// Handoffs
// ---------------------------------------------------------------------------

export const putHandoff = (
  state: RuntimeState,
  id: IssueId,
  entry: HandoffEntry,
): RuntimeState => ({
  ...state,
  handoffs: withEntry(state.handoffs, id, entry),
})

export const removeHandoff = (state: RuntimeState, id: IssueId): RuntimeState => ({
  ...state,
  handoffs: withoutEntry(state.handoffs, id),
})

/** The pull request is finished with: the handoff goes, and the issue is completed and released. */
export const completeHandoff = (
  state: RuntimeState,
  id: IssueId,
  finished: CompletedEntry,
): RuntimeState => completeIssue(removeHandoff(state, id), id, finished)

/**
 * What the store is asked to persist: the handoffs still waiting for hydration, followed by the
 * live ones. A restored handoff that has not been hydrated is still this orchestrator's to keep.
 */
export const handoffSnapshots = (state: RuntimeState): readonly HandoffSnapshot[] => [
  ...state.pendingRestoredHandoffs,
  ...[...state.handoffs.values()].map((handoff) => ({
    issueId: handoff.issue.id,
    identifier: handoff.issue.identifier,
    pullRequestUrl: handoff.pullRequestUrl,
    branchName: handoff.branchName,
    state: handoff.state,
    headSha: handoff.headSha,
    reason: handoff.reason,
    repairAttempts: handoff.repairHeadShas.length,
    repairHeadShas: [...handoff.repairHeadShas],
    repairObservedHeadShas: [...handoff.repairObservedHeadShas],
    repairStartedHeadSha: handoff.repairStartedHeadSha,
    reviewRequestedHeadSha: handoff.reviewRequestedHeadSha,
    reviewCompletedHeadSha: handoff.reviewCompletedHeadSha,
    observedAt: handoff.observedAt.toISOString(),
  })),
]

// ---------------------------------------------------------------------------
// Telemetry records and publication
// ---------------------------------------------------------------------------

export const putDetail = (
  state: RuntimeState,
  id: IssueId,
  record: AgentDetailRecord,
): RuntimeState => ({ ...state, details: withEntry(state.details, id, record) })

/** Rewrites one detail record through a reducer, when the issue still has one. */
export const updateDetail = (
  state: RuntimeState,
  id: IssueId,
  update: (record: AgentDetailRecord) => AgentDetailRecord,
): RuntimeState => {
  const record = state.details.get(id)
  if (record === undefined) {
    return state
  }
  return putDetail(state, id, update(record))
}

/**
 * Rebuilds the published detail index and applies the retention that goes with it: a record whose
 * session has ended joins the finished queue, the queue is trimmed to its cap, and every evicted
 * issue keeps answering as completed rather than as one that never ran.
 *
 * Called after every transition, so what a consumer reads always matches the scheduler it came
 * from. It is idempotent: publishing twice without an intervening change yields the same state.
 */
export const publishDetails = (state: RuntimeState): RuntimeState => {
  const published = new Map<string, PublishedDetail>()
  let finishedDetails = state.finishedDetails
  for (const [id, record] of state.details) {
    const running = state.running.get(id)
    const retry = state.retries.get(id)
    const status: AgentDetailStatus =
      running !== undefined ? 'running' : retry !== undefined ? 'retrying' : 'completed'
    if (status === 'completed') {
      if (!finishedDetails.includes(id)) {
        finishedDetails = [...finishedDetails, id]
      }
    } else {
      finishedDetails = finishedDetails.filter((finished) => finished !== id)
    }
    published.set(record.identifier, {
      _tag: 'Found',
      record,
      context: {
        self: agentDetailPath(record.identifier),
        status,
        stallTimeoutMs: running?.execution.stallTimeoutMs ?? 0,
        workerHost: 'local',
        // Read from the execution the agent is running under, falling back to the workflow in
        // force: composing no code-review services at all is what "handoff disabled" means.
        handoffEnabled: (running?.execution.codeReview ?? state.lastKnownGood.codeReview) !== null,
        branch: record.handoff.expectedBranch,
        retry:
          retry === undefined
            ? null
            : { attempt: retry.attempt, dueAt: new Date(retry.dueAt), reason: retry.error },
      },
    })
  }
  let details = state.details
  let agedOutDetails = state.agedOutDetails
  while (finishedDetails.length > retainedCompletedDetails) {
    const [evicted, ...remaining] = finishedDetails
    finishedDetails = remaining
    const record = evicted === undefined ? undefined : details.get(evicted)
    if (evicted === undefined || record === undefined) {
      continue
    }
    details = withoutEntry(details, evicted)
    agedOutDetails = capped(withMember(agedOutDetails, evicted), rememberedIdentifiers)
    published.set(record.identifier, { _tag: 'Completed' })
  }
  for (const [id, identifier] of state.identifiers) {
    if (published.has(identifier)) {
      continue
    }
    if (state.completed.has(id) || agedOutDetails.has(id)) {
      published.set(identifier, { _tag: 'Completed' })
      continue
    }
    published.set(
      identifier,
      state.claimed.has(id) && !state.running.has(id) && !state.handoffs.has(id)
        ? { _tag: 'Unavailable', reason: 'The agent session is still starting' }
        : { _tag: 'NoSession' },
    )
  }
  return { ...state, details, finishedDetails, agedOutDetails, publishedDetails: published }
}

/** A new session supersedes whatever aged out for this issue. */
export const revivedDetail = (state: RuntimeState, id: IssueId): RuntimeState => ({
  ...state,
  agedOutDetails: withoutMember(state.agedOutDetails, id),
})

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export type TickSource = 'startup' | 'timer' | 'change'

/**
 * The tick debounce, in one place. A tick already queued absorbs any further request; a change that
 * lands while a poll is running additionally owes that poll a follow-up pass, because the poll has
 * already read the state the change invalidated.
 *
 * `enqueue` is whether the caller must offer a `Tick` to the mailbox.
 */
export const requestTick = (
  state: RuntimeState,
  source: TickSource,
): readonly [Readonly<{ enqueue: boolean }>, RuntimeState] => {
  if (state.tickQueued) {
    return [
      { enqueue: false },
      state.pollRunning && source === 'change' ? { ...state, followUpRequested: true } : state,
    ]
  }
  return [{ enqueue: true }, { ...state, tickQueued: true }]
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
export const awaitRefresh = (state: RuntimeState, reply: Deferred.Deferred<void>): RuntimeState =>
  state.pollRunning
    ? { ...state, nextRefreshWaiters: [...state.nextRefreshWaiters, reply] }
    : { ...state, currentRefreshWaiters: [...state.currentRefreshWaiters, reply] }

/** Takes the waiters the finished poll satisfied. */
export const takeRefreshWaiters = (
  state: RuntimeState,
): readonly [readonly Deferred.Deferred<void>[], RuntimeState] => [
  state.currentRefreshWaiters,
  { ...state, currentRefreshWaiters: [] },
]

/** A follow-up pass adopts the callers that were waiting for it. */
export const promoteRefreshWaiters = (state: RuntimeState): RuntimeState => ({
  ...state,
  currentRefreshWaiters: [...state.currentRefreshWaiters, ...state.nextRefreshWaiters],
  nextRefreshWaiters: [],
})

export const setPollTimer = (
  state: RuntimeState,
  timer: RuntimeState['pollTimer'],
): RuntimeState => ({ ...state, pollTimer: timer })

// ---------------------------------------------------------------------------
// Workflow in force
// ---------------------------------------------------------------------------

export const adoptWorkflow = (state: RuntimeState, effective: EffectiveWorkflow): RuntimeState => ({
  ...state,
  lastKnownGood: effective,
})

export const setWorkflowReloadError = (
  state: RuntimeState,
  error: RuntimeState['workflowReloadError'],
): RuntimeState => ({ ...state, workflowReloadError: error })

// ---------------------------------------------------------------------------
// Handoff recovery
// ---------------------------------------------------------------------------

export const noteRecovery = (
  state: RuntimeState,
  counted: Partial<HandoffRecoveryCounts>,
): RuntimeState => ({
  ...state,
  recoveryCounts: {
    loaded: state.recoveryCounts.loaded + (counted.loaded ?? 0),
    recovered: state.recoveryCounts.recovered + (counted.recovered ?? 0),
    skipped: state.recoveryCounts.skipped + (counted.skipped ?? 0),
    failed: state.recoveryCounts.failed + (counted.failed ?? 0),
  },
})

export const resolveRecovery = (state: RuntimeState, id: IssueId): RuntimeState => ({
  ...state,
  recoveryResolved: withMember(state.recoveryResolved, id),
})

export const finishStartupRecovery = (state: RuntimeState): RuntimeState => ({
  ...state,
  startupRecoveryFinished: true,
})

export const setHandoffStoreError = (
  state: RuntimeState,
  error: RuntimeState['handoffStoreError'],
): RuntimeState => ({ ...state, handoffStoreError: error })

export const dropRestoredHandoffs = (
  state: RuntimeState,
  hydrated: ReadonlySet<string>,
): RuntimeState => ({
  ...state,
  pendingRestoredHandoffs: state.pendingRestoredHandoffs.filter(
    (handoff) => !hydrated.has(handoff.issueId),
  ),
})

// ---------------------------------------------------------------------------
// Port lifecycle
// ---------------------------------------------------------------------------

export const noteRetirement = (
  state: RuntimeState,
  retirement: PendingRetirement,
): RuntimeState => ({
  ...state,
  pendingRetirements: [...state.pendingRetirements, retirement],
})

/** Takes the whole pending list; the caller returns whatever is still held. */
export const takeRetirements = (
  state: RuntimeState,
): readonly [readonly PendingRetirement[], RuntimeState] => [
  state.pendingRetirements,
  { ...state, pendingRetirements: [] },
]

export const holdRetirements = (
  state: RuntimeState,
  held: readonly PendingRetirement[],
): RuntimeState => ({ ...state, pendingRetirements: [...state.pendingRetirements, ...held] })

export const noteSupersededPorts = (
  state: RuntimeState,
  runId: number,
  instances: readonly unknown[],
): RuntimeState => ({
  ...state,
  supersededPorts: withEntry(state.supersededPorts, runId, [
    ...(state.supersededPorts.get(runId) ?? []),
    ...instances,
  ]),
})

/** Forgets the ports of runs that have ended: nothing can still be calling through them. */
export const pruneSupersededPorts = (state: RuntimeState): RuntimeState => {
  const live = new Set([...state.running.values()].map((entry) => entry.runId))
  const next = new Map(state.supersededPorts)
  for (const runId of state.supersededPorts.keys()) {
    if (!live.has(runId)) {
      next.delete(runId)
    }
  }
  return next.size === state.supersededPorts.size ? state : { ...state, supersededPorts: next }
}

/**
 * Moves live work onto replacement ports. A running worker and an in-flight handoff each hold the
 * instances their run started with, so a rebuilt tracker reaches them only here.
 *
 * The instances a run is losing are returned per run, so the caller can record what may still have
 * a call in flight against it before the replacement takes over.
 */
export const adoptExecutions = (
  state: RuntimeState,
  previous: EffectiveWorkflow,
  next: EffectiveWorkflow,
): RuntimeState => {
  const adopted = (execution: ExecutionSnapshot): ExecutionSnapshot => ({
    ...execution,
    tracker: next.tracker,
    codeReview:
      execution.codeReview === previous.codeReview ? next.codeReview : execution.codeReview,
    secretEnvironmentNames: [...next.tracker.secretEnvironmentNames],
  })
  let updated = state
  for (const [id, entry] of state.running) {
    if (entry.execution.tracker !== previous.tracker) {
      continue
    }
    // Recorded before the swap: this run's own fibers may still be awaiting a call that read
    // these, and nothing else will remember they were ever in use.
    updated = noteSupersededPorts(
      updated,
      entry.runId,
      [entry.execution.tracker, entry.execution.codeReview].filter((instance) => instance !== null),
    )
    updated = {
      ...updated,
      running: withEntry(updated.running, id, {
        ...entry,
        execution: adopted(entry.execution),
      }),
    }
  }
  for (const [id, entry] of state.handoffs) {
    if (entry.execution.tracker !== previous.tracker) {
      continue
    }
    updated = {
      ...updated,
      handoffs: withEntry(updated.handoffs, id, { ...entry, execution: adopted(entry.execution) }),
    }
  }
  return updated
}
