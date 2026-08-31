import { Effect } from 'effect'

import { normalizeState } from '../domain/domain.js'
import { agentDetailPath, buildAgentDetail } from '../telemetry.js'
import {
  publishedCompletedWork,
  type AgentDetailLookup,
  type CompletedEntry,
  type CompletedSnapshot,
  type OrchestratorContext,
  type OrchestratorSnapshot,
} from './runtime.js'

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
const saturatedStatesOf = (context: OrchestratorContext): readonly string[] => {
  const byState = context.lastKnownGood.workflow.config.agent.maxConcurrentAgentsByState
  if (byState.size === 0) {
    return []
  }
  const running = new Map<string, number>()
  for (const entry of context.state.running.values()) {
    const normalized = normalizeState(entry.issue.state)
    running.set(normalized, (running.get(normalized) ?? 0) + 1)
  }
  return [...byState]
    .filter(([state, limit]) => (running.get(normalizeState(state)) ?? 0) >= limit)
    .map(([state]) => normalizeState(state))
    .sort((left, right) => left.localeCompare(right))
}

/** The identifiers whose detail resource will answer with a snapshot rather than a refusal. */
const inspectableAgentsOf = (context: OrchestratorContext): readonly string[] =>
  [...context.publishedDetails]
    .filter(([, published]) => published._tag === 'Found')
    .map(([identifier]) => identifier)
    .sort((left, right) => left.localeCompare(right))

const completedSnapshot = (entry: CompletedEntry): CompletedSnapshot => ({
  issueId: entry.issueId,
  identifier: entry.identifier,
  title: entry.title,
  url: entry.url,
  outcome: entry.outcome,
  finishedAt: entry.finishedAt.toISOString(),
  pullRequestUrl: entry.pullRequestUrl,
})

export const publishDetails = (context: OrchestratorContext): void => {
  context.publishDetailsValue()
}

export const createSnapshot = (context: OrchestratorContext): OrchestratorSnapshot => {
  const now = Date.now()
  const effective = context.lastKnownGood
  const activeSeconds = [...context.state.running.values()].reduce(
    (total, entry) => total + (now - entry.startedAt.getTime()) / 1_000,
    0,
  )
  const activeTokens = [...context.state.running.values()].reduce(
    (totals, entry) => ({
      inputTokens: totals.inputTokens + entry.tokens.inputTokens,
      outputTokens: totals.outputTokens + entry.tokens.outputTokens,
      totalTokens: totals.totalTokens + entry.tokens.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  )
  return {
    generatedAt: new Date(now).toISOString(),
    workflowPath: context.selectedWorkflowPath,
    effectiveWorkflow: {
      fingerprint: effective.workflow.fingerprint,
      loadedAt: effective.loadedAt.toISOString(),
    },
    workflowReloadError:
      context.workflowReloadError === null
        ? null
        : {
            message: context.workflowReloadError.message,
            observedAt: context.workflowReloadError.observedAt.toISOString(),
          },
    handoffRecovery: {
      status: context.startupRecoveryFinished
        ? context.storeReadFailed || context.handoffStoreError !== null
          ? 'degraded'
          : 'completed'
        : 'recovering',
      loaded: context.recoveryCounts.loaded,
      recovered: context.recoveryCounts.recovered,
      skipped: context.recoveryCounts.skipped,
      failed: context.recoveryCounts.failed,
      storeError:
        context.handoffStoreError === null
          ? null
          : {
              operation: context.handoffStoreError.operation,
              message: context.handoffStoreError.message,
              observedAt: context.handoffStoreError.observedAt.toISOString(),
            },
    },
    pollingIntervalMs: effective.workflow.config.pollingIntervalMs,
    maxConcurrentAgents: effective.workflow.config.agent.maxConcurrentAgents,
    counts: {
      running: context.state.running.size,
      retrying: context.state.retries.size,
      completed: context.state.completed.size,
    },
    pausedIssueNumbers: [...context.state.pausedIssueNumbers].sort((left, right) => left - right),
    handoffs: context.handoffSnapshotsValue(),
    running: [...context.state.running.values()].map((entry) => ({
      issueId: entry.issue.id,
      identifier: entry.issue.identifier,
      title: entry.issue.title,
      url: entry.issue.url,
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
    })),
    retrying: [...context.state.retries.values()].map((entry) => ({
      issueId: entry.issue.id,
      identifier: entry.issue.identifier,
      title: entry.issue.title,
      url: entry.issue.url,
      attempt: entry.attempt,
      dueAt: new Date(entry.dueAt).toISOString(),
      error: entry.error,
      workerHost: 'local',
      detailUrl: agentDetailPath(entry.issue.identifier),
    })),
    completed: [...context.state.completed.values()]
      .sort((left, right) => right.finishedAt.getTime() - left.finishedAt.getTime())
      .slice(0, publishedCompletedWork)
      .map(completedSnapshot),
    saturatedStates: saturatedStatesOf(context),
    inspectableAgents: inspectableAgentsOf(context),
    totals: {
      inputTokens: context.state.totals.inputTokens + activeTokens.inputTokens,
      outputTokens: context.state.totals.outputTokens + activeTokens.outputTokens,
      totalTokens: context.state.totals.totalTokens + activeTokens.totalTokens,
      secondsRunning: context.state.totals.secondsRunning + activeSeconds,
    },
    rateLimits: context.state.rateLimits,
  }
}

export const agentDetail = (
  context: OrchestratorContext,
  identifier: string,
): Effect.Effect<AgentDetailLookup> =>
  Effect.sync(() => {
    const published = context.publishedDetails.get(identifier)
    if (published === undefined) {
      return { _tag: 'Unknown', identifier }
    }
    switch (published._tag) {
      case 'Found': {
        return {
          _tag: 'Found',
          detail: buildAgentDetail(published.record, { ...published.context, now: new Date() }),
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
  })
