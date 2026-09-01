// The per-issue resource SPEC 13.7.2 documents beside `/api/v1/state`, mapped from the same snapshot
// and from the agent detail record the runtime publishes for that issue.

import type { AgentDetailLookup } from '@sloppenheimer/core'
import {
  agentDetailPath,
  timelineEventLimit,
  type AgentDetailSnapshot,
  type AgentErrorSummary,
  type AgentTimelineCategory,
  type AgentTimelineEvent,
} from '@sloppenheimer/core/telemetry.js'

import type { CompletedRow, HandoffRow, RetryingRow, RunningRow, Snapshot } from './state.js'
import { publishTokens, type PublishedTokens } from './tokens.js'

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

/** Every row the snapshot holds for one identifier, read once so the mapping agrees with itself. */
type MatchedRows = Readonly<{
  running: RunningRow | undefined
  retrying: RetryingRow | undefined
  handoff: HandoffRow | undefined
  completed: CompletedRow | undefined
}>

const matchRows = (identifier: string, snapshot: Snapshot): MatchedRows => ({
  running: snapshot.running.find((entry) => entry.identifier === identifier),
  retrying: snapshot.retrying.find((entry) => entry.identifier === identifier),
  handoff: snapshot.handoffs.find((entry) => entry.identifier === identifier),
  completed: snapshot.completed.find((entry) => entry.identifier === identifier),
})

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
 * The single source the rest of the response is taken from.
 *
 * A detail record that reports a live session settles the status by itself. Only once it does not —
 * no record, or a record whose session has finished — do the snapshot rows get a say, and a handoff
 * outranks them because it is what the host is doing about the issue now.
 */
const issueStatus = (
  detail: AgentDetailSnapshot | null,
  rows: MatchedRows,
  lookup: AgentDetailLookup,
): PublishedIssueStatus =>
  detail?.status === 'running'
    ? 'running'
    : detail?.status === 'retrying'
      ? 'retrying'
      : rows.handoff !== undefined
        ? 'handoff'
        : detail !== null
          ? 'completed'
          : rows.running !== undefined
            ? 'running'
            : rows.retrying !== undefined
              ? 'retrying'
              : rows.completed !== undefined
                ? 'completed'
                : lookup._tag === 'Completed'
                  ? 'completed'
                  : lookup._tag === 'Unavailable'
                    ? 'starting'
                    : 'idle'

/**
 * The run block, taken from whichever source {@link issueStatus} was taken from, so a response never
 * carries a run under a status that denies it nor blends two readings of the same agent.
 */
const publishRun = (
  status: PublishedIssueStatus,
  detail: AgentDetailSnapshot | null,
  rows: MatchedRows,
  generatedAt: string,
): PublishedIssueRun | null => {
  if (status !== 'running') {
    return null
  }
  if (detail !== null) {
    return publishRunFromDetail(detail)
  }
  return rows.running === undefined ? null : publishRunFromRow(rows.running, generatedAt)
}

/** The pending-retry block, from the same single source, on the same terms as {@link publishRun}. */
const publishRetry = (
  status: PublishedIssueStatus,
  detail: AgentDetailSnapshot | null,
  rows: MatchedRows,
): PublishedIssueRetry | null => {
  if (status !== 'retrying') {
    return null
  }
  if (detail !== null) {
    const retry = detail.retry
    return retry === null
      ? null
      : { attempt: retry.attempt, due_at: retry.dueAt, reason: retry.reason }
  }
  return rows.retrying === undefined
    ? null
    : { attempt: rows.retrying.attempt, due_at: rows.retrying.dueAt, reason: rows.retrying.error }
}

/**
 * The attempt count the snapshot rows imply, on the canonical record's terms.
 *
 * A retrying row names the attempt that is *scheduled next* — the runtime queues a retry as
 * `(attempt ?? 0) + 1` — whereas the record advances `attempt` and `retries` together, and only
 * when `recordAttemptStarted` folds an actual launch into it. Copying the pending number would
 * report a restart that has not happened, and would make the same issue answer differently
 * depending on whether a detail record happened to be retained. The pending attempt is not lost:
 * it is what `retry.attempt` publishes.
 */
const rowAttempt = (rows: MatchedRows): number =>
  rows.retrying !== undefined
    ? Math.max(0, rows.retrying.attempt - 1)
    : (rows.running?.attempt ?? 0)

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
  const rows = matchRows(identifier, snapshot)
  const known =
    lookup._tag !== 'Unknown' ||
    rows.running !== undefined ||
    rows.retrying !== undefined ||
    rows.handoff !== undefined ||
    rows.completed !== undefined
  if (!known) {
    return null
  }
  const detail = lookup._tag === 'Found' ? lookup.detail : null
  const status = issueStatus(detail, rows, lookup)
  const events = detail === null ? [] : detail.timeline.events.slice(-publishedRecentEvents)
  const lastError = detail?.errors.at(-1)
  const attempt = rowAttempt(rows)
  return {
    self: issueDetailPath(identifier),
    issue_id:
      detail?.issueId ??
      rows.running?.issueId ??
      rows.retrying?.issueId ??
      rows.handoff?.issueId ??
      rows.completed?.issueId ??
      null,
    issue_identifier: identifier,
    issue_url:
      detail?.url ?? rows.running?.url ?? rows.retrying?.url ?? rows.completed?.url ?? null,
    title:
      detail?.title ?? rows.running?.title ?? rows.retrying?.title ?? rows.completed?.title ?? null,
    status,
    tracked:
      status === 'starting' ||
      status === 'running' ||
      status === 'retrying' ||
      status === 'handoff',
    workspace: { path: detail?.workspace.pathKey ?? null },
    attempts: {
      restart_count: detail?.attempt.retries ?? attempt,
      current_retry_attempt: detail?.attempt.current ?? attempt,
    },
    running: publishRun(status, detail, rows, snapshot.generatedAt),
    retry: publishRetry(status, detail, rows),
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
