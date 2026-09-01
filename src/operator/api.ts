// The published shape of the operator API. SPEC 13.7.2 names the baseline document a Sloppenheimer host
// serves from `/api/v1/state`, and it is not the runtime's internal record: it is snake_case, it
// calls a running row's issue `issue_id`, `issue_identifier` and `issue_url`, and it publishes the
// aggregate token counters as `codex_totals`.
//
// The mapping lives here, at the HTTP boundary, rather than in the runtime. `OrchestratorSnapshot`
// is also read by the operator console's own backend and by the agent detail path, so renaming its
// fields to match the wire would push a published vocabulary back into the scheduler. One function
// converts, once, and everything the server sends goes through it.
//
// Sloppenheimer publishes a superset of the baseline — handoffs, workflow reload state, handoff
// recovery, retained completions, saturated states — and those extension fields follow the same
// snake_case convention, so a reader never has to know which half of the document they are in.
//
// The per-issue resource 13.7.2 documents beside `/api/v1/state` is mapped here too, from the same
// snapshot and from the agent detail record the runtime publishes for that issue.

import type { AgentDetailLookup, OrchestratorSnapshot, RefreshOutcome } from '@sloppenheimer/core'
import {
  agentDetailPath,
  timelineEventLimit,
  type AgentDetailSnapshot,
  type AgentErrorSummary,
  type AgentTimelineCategory,
  type AgentTimelineEvent,
} from '@sloppenheimer/core/telemetry.js'

type Snapshot = OrchestratorSnapshot
type RunningRow = Snapshot['running'][number]
type RetryingRow = Snapshot['retrying'][number]
type CompletedRow = Snapshot['completed'][number]
type HandoffRow = Snapshot['handoffs'][number]

/** Token counters as the wire spells them. The seconds counter is only on the aggregate. */
export type PublishedTokens = Readonly<{
  input_tokens: number
  output_tokens: number
  total_tokens: number
}>

export type PublishedTotals = PublishedTokens & Readonly<{ seconds_running: number }>

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

type TokenCounters = Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }>

const publishTokens = (tokens: TokenCounters): PublishedTokens => ({
  input_tokens: tokens.inputTokens,
  output_tokens: tokens.outputTokens,
  total_tokens: tokens.totalTokens,
})

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

/**
 * How many timeline events the per-issue resource publishes. The baseline asks for recent events
 * rather than the whole timeline; the complete, typed timeline stays at the agent detail resource,
 * which is what {@link PublishedIssueDetail.detail_url} points at.
 */
export const publishedRecentEvents = 20

/**
 * The versioned per-issue resource SPEC 13.7.2 describes.
 *
 * An identifier spelled exactly `state` or `backlog` names a fixed GET route instead, so the link
 * this builds answers for that route rather than for the issue. #220 recorded that as a known limit
 * of the SPEC's namespace rather than moving the resource; `README.md` names the two and why
 * nothing is escaped here.
 */
export const issueDetailPath = (identifier: string): string =>
  `/api/v1/${encodeURIComponent(identifier)}`

/**
 * What the host is doing about this issue right now.
 *
 * `starting` is a claimed issue whose worker has not launched yet, `handoff` is work that has left
 * the agent for the pull-request lifecycle, and `idle` is an issue in-memory state still knows
 * about with no session, handoff or completion attached to it.
 */
export type PublishedIssueStatus =
  | 'starting'
  | 'running'
  | 'retrying'
  | 'handoff'
  | 'completed'
  | 'idle'

export type PublishedIssueRun = Readonly<{
  started_at: string
  last_activity_at: string | null
  elapsed_ms: number
  idle_ms: number | null
  phase: string | null
  operation: string | null
  thread_id: string | null
  turn_id: string | null
  session_id: string | null
  process_id: number | null
  turn_number: number
  worker_host: string
  stall_deadline: string | null
  stalled: boolean
  tokens: PublishedTokens
}>

export type PublishedIssueRetry = Readonly<{
  attempt: number
  due_at: string
  reason: string | null
}>

export type PublishedIssueEvent = Readonly<{
  sequence: number
  at: string
  attempt: number
  category: AgentTimelineCategory
  event: string
  operation: string | null
}>

export type PublishedIssueError = Readonly<{
  at: string
  attempt: number
  severity: AgentErrorSummary['severity']
  code: string | null
  message: string
}>

export type PublishedIssueDetail = Readonly<{
  self: string
  issue_id: string | null
  issue_identifier: string
  issue_url: string | null
  title: string | null
  status: PublishedIssueStatus
  /**
   * Whether the orchestrator is tracking this issue as live work, as opposed to retaining it as
   * history. Starting, running, retrying and handed-off work is tracked; a completed or idle issue
   * is answered from retention.
   */
  tracked: boolean
  /**
   * The workspace this issue's agent runs in, published as the deterministic workspace key rather
   * than the host absolute path. The path is a host filesystem detail the console never needs, and
   * the detail pipeline redacts it before retention, so there is no absolute path to publish.
   */
  workspace: Readonly<{ path: string | null }>
  attempts: Readonly<{ restart_count: number; current_retry_attempt: number }>
  running: PublishedIssueRun | null
  retry: PublishedIssueRetry | null
  /**
   * Timeline retention accounting. Sloppenheimer retains a bounded, redacted event timeline rather than
   * raw agent logs, so this reports what is retained, what was dropped against the bound, and how
   * much of it {@link PublishedIssueDetail.recent_events} carries.
   */
  logs: Readonly<{ retained: number; dropped: number; limit: number; published: number }>
  recent_events: readonly PublishedIssueEvent[]
  last_error: PublishedIssueError | null
  /** The superset resource, with the full timeline and the four distinguished outcomes. */
  detail_url: string
}>

const publishTimelineEvent = (event: AgentTimelineEvent): PublishedIssueEvent => ({
  sequence: event.sequence,
  at: event.at,
  attempt: event.attempt,
  category: event.category,
  event: event.event,
  operation: event.operation,
})

const publishError = (error: AgentErrorSummary): PublishedIssueError => ({
  at: error.at,
  attempt: error.attempt,
  severity: error.severity,
  code: error.code,
  message: error.message,
})

/**
 * Milliseconds between two published instants. Both sides are ISO strings the runtime produced, so
 * an unparseable one means the snapshot itself is malformed rather than that the agent has run for
 * a strange length of time; report nothing elapsed instead of `NaN`.
 */
const elapsedMs = (from: string, to: string): number => {
  const started = Date.parse(from)
  const generated = Date.parse(to)
  return Number.isFinite(started) && Number.isFinite(generated)
    ? Math.max(0, generated - started)
    : 0
}

const publishRunFromDetail = (detail: AgentDetailSnapshot): PublishedIssueRun => ({
  started_at: detail.activity.startedAt,
  last_activity_at: detail.activity.lastActivityAt,
  elapsed_ms: detail.activity.elapsedMs,
  idle_ms: detail.activity.idleMs,
  phase: detail.phase.phase,
  operation: detail.phase.operation,
  thread_id: detail.identity.threadId,
  turn_id: detail.identity.turnId,
  session_id: detail.identity.sessionId,
  process_id: detail.identity.processId,
  turn_number: detail.identity.turnNumber,
  worker_host: detail.identity.workerHost,
  stall_deadline: detail.activity.stallDeadline,
  stalled: detail.activity.stalled,
  tokens: publishTokens(detail.usage),
})

/**
 * Whether the deadline a running row publishes has passed at the instant that row was taken. The
 * row carries the deadline rather than a flag, precisely so a reader can decide this; hard-coding
 * `false` would publish an already-stalled agent as healthy beside the deadline that says
 * otherwise. A row with stall detection off has no deadline and is never stalled.
 */
const stalledAt = (stallDeadline: string | null, generatedAt: string): boolean => {
  if (stallDeadline === null) {
    return false
  }
  const deadline = Date.parse(stallDeadline)
  const generated = Date.parse(generatedAt)
  return Number.isFinite(deadline) && Number.isFinite(generated) && generated >= deadline
}

/**
 * The running row stands in when the actor has published no detail record for a live agent. It
 * carries scheduling identity but not the phase and idle accounting the detail pipeline folds, so
 * those fields are absent rather than invented.
 */
const publishRunFromRow = (row: RunningRow, generatedAt: string): PublishedIssueRun => ({
  started_at: row.startedAt,
  last_activity_at: row.lastEventAt,
  elapsed_ms: elapsedMs(row.startedAt, generatedAt),
  idle_ms: row.lastEventAt === null ? null : elapsedMs(row.lastEventAt, generatedAt),
  phase: null,
  operation: row.lastEvent,
  thread_id: row.threadId,
  turn_id: row.turnId,
  session_id: row.sessionId,
  process_id: row.processId,
  turn_number: row.turnCount,
  worker_host: row.workerHost,
  stall_deadline: row.stallDeadline,
  stalled: stalledAt(row.stallDeadline, generatedAt),
  tokens: publishTokens(row.tokens),
})

/**
 * The per-issue baseline for one identifier, or `null` when in-memory state has never heard of it.
 *
 * Every issue the runtime knows resolves, not only the ones in the running and retrying maps: an
 * issue whose work has moved to the pull-request handoff lifecycle is as known to the host as a
 * running one, and answering `404` for it would report absence the host can disprove. The detail
 * lookup already distinguishes an unknown identifier from a known one with no live session, so the
 * two sources agree on what "unknown" means.
 *
 * The snapshot and the detail are two reads of the actor's state, so an agent that changes state
 * between them leaves this function holding one stale value and one fresh one. What must never
 * follow is a response that contradicts itself — a `running` block beside a `retry` block, under a
 * status only one of them supports. `status` therefore picks a single source, and the live-state
 * fields come from that source alone: the detail record whenever it has one to give, because it is
 * the actor's own statement about the session, and the snapshot rows only where it does not. The
 * response is then one source's reading, taken slightly earlier or slightly later, rather than a
 * blend of both.
 */
export const publishIssueDetail = (
  identifier: string,
  snapshot: Snapshot,
  lookup: AgentDetailLookup,
): PublishedIssueDetail | null => {
  const running = snapshot.running.find((entry) => entry.identifier === identifier)
  const retrying = snapshot.retrying.find((entry) => entry.identifier === identifier)
  const handoff = snapshot.handoffs.find((entry) => entry.identifier === identifier)
  const completed = snapshot.completed.find((entry) => entry.identifier === identifier)
  const known =
    lookup._tag !== 'Unknown' ||
    running !== undefined ||
    retrying !== undefined ||
    handoff !== undefined ||
    completed !== undefined
  if (!known) {
    return null
  }
  const detail = lookup._tag === 'Found' ? lookup.detail : null
  // A detail record that reports a live session settles the status by itself. Only once it does not
  // — no record, or a record whose session has finished — do the snapshot rows get a say, and a
  // handoff outranks them because it is what the host is doing about the issue now.
  const status: PublishedIssueStatus =
    detail?.status === 'running'
      ? 'running'
      : detail?.status === 'retrying'
        ? 'retrying'
        : handoff !== undefined
          ? 'handoff'
          : detail !== null
            ? 'completed'
            : running !== undefined
              ? 'running'
              : retrying !== undefined
                ? 'retrying'
                : completed !== undefined
                  ? 'completed'
                  : lookup._tag === 'Completed'
                    ? 'completed'
                    : lookup._tag === 'Unavailable'
                      ? 'starting'
                      : 'idle'
  const events = detail === null ? [] : detail.timeline.events.slice(-publishedRecentEvents)
  const lastError = detail?.errors.at(-1)
  const detailRetry = detail?.retry ?? null
  /*
   * The attempt count the snapshot rows imply, on the canonical record's terms.
   *
   * A retrying row names the attempt that is *scheduled next* — the runtime queues a retry as
   * `(attempt ?? 0) + 1` — whereas the record advances `attempt` and `retries` together, and only
   * when `recordAttemptStarted` folds an actual launch into it. Copying the pending number would
   * report a restart that has not happened, and would make the same issue answer differently
   * depending on whether a detail record happened to be retained. The pending attempt is not lost:
   * it is what `retry.attempt` publishes.
   */
  const rowAttempt =
    retrying !== undefined ? Math.max(0, retrying.attempt - 1) : (running?.attempt ?? 0)
  // Both come from whichever source `status` was taken from, so a response never carries a run and
  // a pending retry at once, nor either one under a status that denies it.
  const publishedRun: PublishedIssueRun | null =
    status !== 'running'
      ? null
      : detail !== null
        ? publishRunFromDetail(detail)
        : running === undefined
          ? null
          : publishRunFromRow(running, snapshot.generatedAt)
  const publishedRetry: PublishedIssueRetry | null =
    status !== 'retrying'
      ? null
      : detail !== null
        ? detailRetry === null
          ? null
          : { attempt: detailRetry.attempt, due_at: detailRetry.dueAt, reason: detailRetry.reason }
        : retrying === undefined
          ? null
          : { attempt: retrying.attempt, due_at: retrying.dueAt, reason: retrying.error }
  return {
    self: issueDetailPath(identifier),
    issue_id:
      detail?.issueId ??
      running?.issueId ??
      retrying?.issueId ??
      handoff?.issueId ??
      completed?.issueId ??
      null,
    issue_identifier: identifier,
    issue_url: detail?.url ?? running?.url ?? retrying?.url ?? completed?.url ?? null,
    title: detail?.title ?? running?.title ?? retrying?.title ?? completed?.title ?? null,
    status,
    tracked:
      status === 'starting' ||
      status === 'running' ||
      status === 'retrying' ||
      status === 'handoff',
    workspace: { path: detail?.workspace.pathKey ?? null },
    attempts: {
      restart_count: detail?.attempt.retries ?? rowAttempt,
      current_retry_attempt: detail?.attempt.current ?? rowAttempt,
    },
    running: publishedRun,
    retry: publishedRetry,
    logs: {
      retained: detail?.timeline.retained ?? 0,
      dropped: detail?.timeline.dropped ?? 0,
      limit: detail?.timeline.limit ?? timelineEventLimit,
      published: events.length,
    },
    recent_events: events.map(publishTimelineEvent),
    last_error: lastError === undefined ? null : publishError(lastError),
    detail_url: agentDetailPath(identifier),
  }
}
