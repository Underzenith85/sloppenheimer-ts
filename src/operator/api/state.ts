// The baseline document a Sloppenheimer host serves from `/api/v1/state`, and the acknowledgement
// `POST /api/v1/refresh` returns.
//
// This module also names the snapshot vocabulary the rest of the mapping reads: `Snapshot` and its
// row types are the runtime's own record, which the per-issue resource beside it reads too.

import type { OrchestratorSnapshot, RefreshOutcome } from '@sloppenheimer/core'

import { publishTokens, type PublishedTokens, type PublishedTotals } from './tokens.js'

export type Snapshot = OrchestratorSnapshot
export type RunningRow = Snapshot['running'][number]
export type RetryingRow = Snapshot['retrying'][number]
export type CompletedRow = Snapshot['completed'][number]
export type HandoffRow = Snapshot['handoffs'][number]

export type PublishedRunning = Readonly<{
  issue_id: string
  issue_identifier: string
  issue_url: string | null
  title: string
  /** The issue state the tracker reports, which SPEC 13.7.2 requires on a running row. */
  state: string
  attempt: number | null
  started_at: string
  last_event_at: string | null
  last_event: string | null
  last_message: string | null
  process_id: number | null
  thread_id: string | null
  turn_id: string | null
  session_id: string | null
  turn_count: number
  tokens: PublishedTokens
  last_reported_tokens: PublishedTokens
  worker_host: 'local'
  stall_deadline: string | null
  detail_url: string
}>

export type PublishedRetrying = Readonly<{
  issue_id: string
  issue_identifier: string
  issue_url: string | null
  title: string
  attempt: number
  due_at: string
  error: string | null
  worker_host: 'local'
  detail_url: string
}>

export type PublishedCompleted = Readonly<{
  issue_id: string
  issue_identifier: string
  issue_url: string | null
  title: string
  outcome: 'merged'
  finished_at: string
  pull_request_url: string | null
}>

export type PublishedHandoff = Readonly<{
  issue_id: string
  issue_identifier: string
  pull_request_url: string
  branch_name: string
  state: HandoffRow['state']
  head_sha: string | null
  reason: string | null
  repair_attempts: number
  observed_at: string
}>

export type PublishedState = Readonly<{
  generated_at: string
  workflow_path: string
  effective_workflow: Readonly<{ fingerprint: string; loaded_at: string }>
  workflow_reload_error: Readonly<{ message: string; observed_at: string }> | null
  handoff_recovery: Readonly<{
    status: Snapshot['handoffRecovery']['status']
    loaded: number
    recovered: number
    skipped: number
    failed: number
    store_error: Readonly<{
      operation: 'read' | 'write'
      message: string
      observed_at: string
    }> | null
  }>
  polling_interval_ms: number
  max_concurrent_agents: number
  counts: Readonly<{ running: number; retrying: number; completed: number }>
  paused_issue_numbers: readonly number[]
  handoffs: readonly PublishedHandoff[]
  running: readonly PublishedRunning[]
  retrying: readonly PublishedRetrying[]
  completed: readonly PublishedCompleted[]
  saturated_states: readonly string[]
  inspectable_agents: readonly string[]
  codex_totals: PublishedTotals
  /**
   * The coding agent's own rate-limit report, passed through as it arrived. Its keys belong to that
   * protocol rather than to this API, so they are not renamed.
   */
  rate_limits: Snapshot['rateLimits']
}>

/**
 * The acknowledgement `POST /api/v1/refresh` returns. Sloppenheimer answers once the pass the request
 * joined has finished, so a caller that reads `/api/v1/state` next sees the refreshed state.
 */
export type PublishedRefresh = Readonly<{
  queued: boolean
  coalesced: boolean
  requested_at: string
  /** The stages the pass that answered the request reached — not the stages a pass could reach. */
  operations: readonly string[]
}>

const publishRunning = (entry: RunningRow): PublishedRunning => ({
  issue_id: entry.issueId,
  issue_identifier: entry.identifier,
  issue_url: entry.url,
  title: entry.title,
  state: entry.state,
  attempt: entry.attempt,
  started_at: entry.startedAt,
  last_event_at: entry.lastEventAt,
  last_event: entry.lastEvent,
  last_message: entry.lastMessage,
  process_id: entry.processId,
  thread_id: entry.threadId,
  turn_id: entry.turnId,
  session_id: entry.sessionId,
  turn_count: entry.turnCount,
  tokens: publishTokens(entry.tokens),
  last_reported_tokens: publishTokens(entry.lastReportedTokens),
  worker_host: entry.workerHost,
  stall_deadline: entry.stallDeadline,
  detail_url: entry.detailUrl,
})

const publishRetrying = (entry: RetryingRow): PublishedRetrying => ({
  issue_id: entry.issueId,
  issue_identifier: entry.identifier,
  issue_url: entry.url,
  title: entry.title,
  attempt: entry.attempt,
  due_at: entry.dueAt,
  error: entry.error,
  worker_host: entry.workerHost,
  detail_url: entry.detailUrl,
})

const publishCompleted = (entry: CompletedRow): PublishedCompleted => ({
  issue_id: entry.issueId,
  issue_identifier: entry.identifier,
  issue_url: entry.url,
  title: entry.title,
  outcome: entry.outcome,
  finished_at: entry.finishedAt,
  pull_request_url: entry.pullRequestUrl,
})

const publishHandoff = (entry: HandoffRow): PublishedHandoff => ({
  issue_id: entry.issueId,
  issue_identifier: entry.identifier,
  pull_request_url: entry.pullRequestUrl,
  branch_name: entry.branchName,
  state: entry.state,
  head_sha: entry.headSha,
  reason: entry.reason,
  repair_attempts: entry.repairAttempts,
  observed_at: entry.observedAt,
})

export const publishState = (snapshot: Snapshot): PublishedState => ({
  generated_at: snapshot.generatedAt,
  workflow_path: snapshot.workflowPath,
  effective_workflow: {
    fingerprint: snapshot.effectiveWorkflow.fingerprint,
    loaded_at: snapshot.effectiveWorkflow.loadedAt,
  },
  workflow_reload_error:
    snapshot.workflowReloadError === null
      ? null
      : {
          message: snapshot.workflowReloadError.message,
          observed_at: snapshot.workflowReloadError.observedAt,
        },
  handoff_recovery: {
    status: snapshot.handoffRecovery.status,
    loaded: snapshot.handoffRecovery.loaded,
    recovered: snapshot.handoffRecovery.recovered,
    skipped: snapshot.handoffRecovery.skipped,
    failed: snapshot.handoffRecovery.failed,
    store_error:
      snapshot.handoffRecovery.storeError === null
        ? null
        : {
            operation: snapshot.handoffRecovery.storeError.operation,
            message: snapshot.handoffRecovery.storeError.message,
            observed_at: snapshot.handoffRecovery.storeError.observedAt,
          },
  },
  polling_interval_ms: snapshot.pollingIntervalMs,
  max_concurrent_agents: snapshot.maxConcurrentAgents,
  counts: snapshot.counts,
  paused_issue_numbers: snapshot.pausedIssueNumbers,
  handoffs: snapshot.handoffs.map(publishHandoff),
  running: snapshot.running.map(publishRunning),
  retrying: snapshot.retrying.map(publishRetrying),
  completed: snapshot.completed.map(publishCompleted),
  saturated_states: snapshot.saturatedStates,
  inspectable_agents: snapshot.inspectableAgents,
  codex_totals: {
    ...publishTokens(snapshot.totals),
    seconds_running: snapshot.totals.secondsRunning,
  },
  rate_limits: snapshot.rateLimits,
})

export const publishRefresh = (outcome: RefreshOutcome): PublishedRefresh => ({
  queued: true,
  coalesced: outcome.coalesced,
  requested_at: outcome.requestedAt,
  operations: outcome.operations,
})
