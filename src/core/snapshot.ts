import { Effect } from 'effect'

import { agentDetailPath, buildAgentDetail } from '../telemetry.js'
import type { AgentDetailLookup, OrchestratorContext, OrchestratorSnapshot } from './runtime.js'

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
