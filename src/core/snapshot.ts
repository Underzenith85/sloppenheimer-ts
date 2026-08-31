import { Effect, Ref } from 'effect'

import { agentDetailPath, buildAgentDetail } from '../telemetry.js'
import type { AgentDetailLookup, OrchestratorContext, OrchestratorSnapshot } from './runtime.js'
import type { RuntimeState } from './state.js'
import { handoffSnapshots } from './transitions.js'

/**
 * The operator's view of one instant. Pure in the state it is given: the value was read from the
 * cell in a single step, so nothing here has to defend against a container being edited underneath
 * it, and no copying is needed to hand it on.
 */
export const createSnapshot = (state: RuntimeState, workflowPath: string): OrchestratorSnapshot => {
  const now = Date.now()
  const effective = state.lastKnownGood
  const running = [...state.running.values()]
  const activeSeconds = running.reduce(
    (total, entry) => total + (now - entry.startedAt.getTime()) / 1_000,
    0,
  )
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
      completed: state.completed.size,
    },
    pausedIssueNumbers: [...state.pausedIssueNumbers].sort((left, right) => left - right),
    handoffs: handoffSnapshots(state),
    running: running.map((entry) => ({
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
    retrying: [...state.retries.values()].map((entry) => ({
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
  Ref.get(context.state).pipe(
    Effect.map((state): AgentDetailLookup => {
      const published = state.publishedDetails.get(identifier)
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
    }),
  )
