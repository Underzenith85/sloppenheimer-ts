import { Effect, Ref } from 'effect'

import { normalizeState } from '../domain/domain.js'
import { currentInstant } from '../support/clock.js'
import { agentDetailPath, buildAgentDetail } from '../telemetry.js'
import {
  type AgentDetailLookup,
  type DeliverySnapshot,
  type OrchestratorContext,
  type OrchestratorSnapshot,
  type RetrySnapshot,
  type RunningSnapshot,
} from './runtime.js'
import type { DeliveryEntry } from './postflight.js'
import type { RetryEntry, RunningEntry, RuntimeState } from './state.js'
import { handoffSnapshots, publishedCompletions } from './transitions.js'

/**
 * When an agent is considered stalled, as an absolute instant. A zero timeout means stall
 * detection is off for that agent, which the console must be able to tell apart from a deadline
 * that has not arrived yet.
 */
const stallDeadlineOf = (lastActiveAt: Date, stallTimeoutMs: number): string | null =>
  stallTimeoutMs > 0 ? new Date(lastActiveAt.getTime() + stallTimeoutMs).toISOString() : null

/**
 * The normalized issue states that cannot take another agent right now. Only states the workflow
 * gives an explicit cap can saturate ahead of the global limit, so only those are considered; the
 * global limit is already published as `maxConcurrentAgents` beside the running count.
 */
const saturatedStatesOf = (state: RuntimeState): readonly string[] => {
  const byState = state.lastKnownGood.workflow.config.agent.maxConcurrentAgentsByState
  if (byState.size === 0) {
    return []
  }
  const running = new Map<string, number>()
  for (const entry of state.running.values()) {
    const normalized = normalizeState(entry.issue.state)
    running.set(normalized, (running.get(normalized) ?? 0) + 1)
  }
  return [...byState]
    .filter(([issueState, limit]) => (running.get(normalizeState(issueState)) ?? 0) >= limit)
    .map(([issueState]) => normalizeState(issueState))
    .sort((left, right) => left.localeCompare(right))
}

/** The identifiers whose detail resource will answer with a snapshot rather than a refusal. */
const inspectableAgentsOf = (state: RuntimeState): readonly string[] =>
  [...state.publishedDetails]
    .filter(([, published]) => published._tag === 'Found')
    .map(([identifier]) => identifier)
    .sort((left, right) => left.localeCompare(right))

const runningSnapshot = (entry: RunningEntry): RunningSnapshot => ({
  issueId: entry.issue.id,
  identifier: entry.issue.identifier,
  title: entry.issue.title,
  url: entry.issue.url,
  state: entry.issue.state,
  attempt: entry.attempt,
  startedAt: entry.startedAt.toISOString(),
  lastEventAt: entry.lastEventAt?.toISOString() ?? null,
  lastEvent: entry.lastEvent,
  lastMessage: entry.lastMessage,
  processId: entry.processId,
  threadId: entry.threadId,
  turnId: entry.turnId,
  sessionId: entry.sessionId,
  turnCount: entry.turnCount,
  tokens: entry.tokens,
  lastReportedTokens: entry.lastReportedTokens,
  workerHost: 'local',
  stallDeadline: stallDeadlineOf(
    entry.lastEventAt ?? entry.startedAt,
    entry.execution.stallTimeoutMs,
  ),
  detailUrl: agentDetailPath(entry.issue.identifier),
})

const retrySnapshot = (entry: RetryEntry): RetrySnapshot => ({
  issueId: entry.issue.id,
  identifier: entry.issue.identifier,
  title: entry.issue.title,
  url: entry.issue.url,
  attempt: entry.attempt,
  dueAt: new Date(entry.dueAt).toISOString(),
  error: entry.error,
  workerHost: 'local',
  detailUrl: agentDetailPath(entry.issue.identifier),
})

/**
 * One piece of work waiting to reach the remote. The reason names the typed source-control
 * category rather than only the message, so an operator can tell a lease conflict — which the next
 * attempt may well resolve — from an authentication failure, which it will not.
 */
const deliverySnapshot = (entry: DeliveryEntry): DeliverySnapshot => ({
  issueId: entry.issue.id,
  identifier: entry.issue.identifier,
  title: entry.issue.title,
  url: entry.issue.url,
  branchName: entry.prepared.target.branchName,
  attempt: entry.attempt,
  dueAt: new Date(entry.dueAt).toISOString(),
  category: entry.failure.category,
  reason: entry.failure.message,
  changedFileCount: entry.changedFileCount,
  repairRun: entry.repairRun,
  observedAt: entry.observedAt.toISOString(),
  workerHost: 'local',
  detailUrl: agentDetailPath(entry.issue.identifier),
})

/**
 * The operator's view of one instant. Pure in the state it is given: the value was read from the
 * cell in a single step, so nothing here has to defend against a container being edited underneath
 * it, and no copying is needed to hand it on.
 */
export const createSnapshot = (
  state: RuntimeState,
  workflowPath: string,
  now: number,
): OrchestratorSnapshot => {
  const effective = state.lastKnownGood
  const running = [...state.running.values()]
  const activeSeconds = running.reduce(
    (total, entry) => total + (now - entry.startedAt.getTime()) / 1_000,
    0,
  )
  const completed = publishedCompletions(state)
  const activeTokens = running.reduce(
    (totals, entry) => ({
      inputTokens: totals.inputTokens + entry.tokens.inputTokens,
      outputTokens: totals.outputTokens + entry.tokens.outputTokens,
      totalTokens: totals.totalTokens + entry.tokens.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  )
  return {
    generatedAt: new Date(now).toISOString(),
    workflowPath,
    effectiveWorkflow: {
      fingerprint: effective.workflow.fingerprint,
      loadedAt: effective.loadedAt.toISOString(),
    },
    workflowReloadError:
      state.workflowReloadError === null
        ? null
        : {
            message: state.workflowReloadError.message,
            observedAt: state.workflowReloadError.observedAt.toISOString(),
          },
    handoffRecovery: {
      status: state.startupRecoveryFinished
        ? state.storeReadFailed || state.handoffStoreError !== null
          ? 'degraded'
          : 'completed'
        : 'recovering',
      loaded: state.recoveryCounts.loaded,
      recovered: state.recoveryCounts.recovered,
      skipped: state.recoveryCounts.skipped,
      failed: state.recoveryCounts.failed,
      storeError:
        state.handoffStoreError === null
          ? null
          : {
              operation: state.handoffStoreError.operation,
              message: state.handoffStoreError.message,
              observedAt: state.handoffStoreError.observedAt.toISOString(),
            },
    },
    pollingIntervalMs: effective.workflow.config.pollingIntervalMs,
    maxConcurrentAgents: effective.workflow.config.agent.maxConcurrentAgents,
    counts: {
      running: state.running.size,
      retrying: state.retries.size,
      delivering: state.deliveries.size,
      // What this snapshot publishes, restored history included: each count states the length of
      // the list beside it, and `completed` is the one of the four that is bounded.
      completed: completed.length,
    },
    pausedIssueNumbers: [...state.pausedIssueNumbers].sort((left, right) => left - right),
    handoffs: handoffSnapshots(state),
    running: running.map(runningSnapshot),
    retrying: [...state.retries.values()].map(retrySnapshot),
    delivering: [...state.deliveries.values()].map(deliverySnapshot),
    completed,
    saturatedStates: saturatedStatesOf(state),
    inspectableAgents: inspectableAgentsOf(state),
    totals: {
      inputTokens: state.totals.inputTokens + activeTokens.inputTokens,
      outputTokens: state.totals.outputTokens + activeTokens.outputTokens,
      totalTokens: state.totals.totalTokens + activeTokens.totalTokens,
      secondsRunning: state.totals.secondsRunning + activeSeconds,
    },
    rateLimits: state.rateLimits,
  }
}

export const agentDetail = (
  context: OrchestratorContext,
  identifier: string,
): Effect.Effect<AgentDetailLookup> =>
  Effect.all([Ref.get(context.state), currentInstant]).pipe(
    Effect.map(([state, now]): AgentDetailLookup => {
      const published = state.publishedDetails.get(identifier)
      if (published === undefined) {
        return { _tag: 'Unknown', identifier }
      }
      switch (published._tag) {
        case 'Found': {
          return {
            _tag: 'Found',
            detail: buildAgentDetail(published.record, { ...published.context, now }),
          }
        }
        case 'Completed': {
          return { _tag: 'Completed', identifier }
        }
        case 'Unavailable': {
          return { _tag: 'Unavailable', identifier, reason: published.reason }
        }
        case 'NoSession': {
          return { _tag: 'NoSession', identifier }
        }
      }
    }),
  )
