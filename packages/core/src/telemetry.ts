/**
 * Canonical agent session telemetry.
 *
 * One pipeline carries everything an operator can see about a live agent: the selected runner's
 * adapter normalizes each protocol message into a bounded, already-redacted
 * {@link AgentEventPayload} and states what that message means for the session's lifecycle, and the
 * orchestrator folds those payloads — plus the scheduling facts only it knows, such as retries,
 * cancellations, and pull-request handoff — into an actor-owned {@link AgentDetailRecord}. The
 * record is never read directly by a consumer; the actor publishes exact, immutable
 * {@link AgentDetailSnapshot} values built from it.
 */

import type { IssueId, IssueIdentifier, JsonObject, JsonValue } from './domain/domain.js'
import {
  decodeOrNull,
  finiteNumber,
  protocolRecord,
  protocolStruct,
  tolerant,
} from './support/schema.js'
import { bound, boundRedacted, redact } from './support/redaction.js'

/** How many timeline events are retained per issue. Older events are dropped and counted. */
export const timelineEventLimit = 200
/** How many distinct changed paths are retained in the aggregate workspace summary. */
export const changedPathLimit = 50
/** How many error summaries are retained. */
export const retainedErrorLimit = 10
/** How many attempt and session summaries are retained. */
export const retainedAttemptLimit = 20

/**
 * The versioned detail endpoint for one issue. Both the runtime snapshot's self link and the
 * snapshot's own `self` field are built here, so an operator can copy either and reach the same
 * resource.
 */
export const agentDetailPath = (identifier: string): string =>
  `/api/v1/agents/${encodeURIComponent(identifier)}`

export type TokenCounts = Readonly<{
  inputTokens: number
  outputTokens: number
  totalTokens: number
}>

export type RateLimitWindow = Readonly<{
  name: string
  usedPercent: number | null
  windowMinutes: number | null
  resetsInSeconds: number | null
}>

export type ToolState = 'started' | 'completed' | 'failed' | 'approved' | 'withheld'
export type FileChangeKind = 'add' | 'update' | 'delete' | 'unknown'
export type MessageRole = 'assistant' | 'user'
export type ErrorSeverity = 'warning' | 'error'

/** The quality command an agent is running, recognized from an allowlist of subcommand words. */
export type QualityPhase = 'format' | 'lint' | 'typecheck' | 'test' | 'build' | 'check'

const qualityPhases: readonly QualityPhase[] = [
  'format',
  'lint',
  'typecheck',
  'test',
  'build',
  'check',
]

/**
 * The normalized, bounded form of one protocol message. Everything unbounded in the original —
 * tool input and output, file contents, command arguments, reasoning text — is reduced to counts
 * and allowlisted labels here, at the parser, so no consumer ever holds the original.
 */
export type AgentEventPayload =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'session' }>
  | Readonly<{ kind: 'reasoning' }>
  | Readonly<{ kind: 'message'; role: MessageRole; text: string | null; truncated: boolean }>
  | Readonly<{
      kind: 'tool'
      name: string
      state: ToolState
      inputBytes: number | null
      outputBytes: number | null
    }>
  | Readonly<{
      kind: 'command'
      program: string
      argumentCount: number
      quality: QualityPhase | null
      state: ToolState
      exitCode: number | null
      durationMs: number | null
    }>
  | Readonly<{
      kind: 'file'
      path: string
      change: FileChangeKind
      addedLines: number | null
      deletedLines: number | null
    }>
  | Readonly<{
      kind: 'error'
      severity: ErrorSeverity
      code: string | null
      message: string
      truncated: boolean
    }>
  | Readonly<{ kind: 'cancellation'; reason: string }>

export type AgentTurnOutcome = 'completed' | 'cancelled' | 'failed'

/**
 * What one event means for the session's lifecycle, as the runner that emitted it reads its own
 * vocabulary.
 *
 * The orchestrator used to recognize the lifecycle by matching one backend's literal method names,
 * which meant a runner with a different vocabulary would run to completion while the scheduler
 * observed nothing at all. Stating the meaning on the event removes that failure mode entirely: an adapter
 * cannot forget to be understood, and no consumer can consult the wrong runner's reading. `null` is
 * the ordinary case — most messages report progress rather than a lifecycle transition.
 */
export type AgentLifecycle =
  | Readonly<{ phase: 'session_started' }>
  | Readonly<{ phase: 'turn_started' }>
  | Readonly<{ phase: 'turn_settled'; outcome: AgentTurnOutcome }>

/**
 * The canonical session event. Identity, token totals, rate limits, turn count, and turn status are
 * the normalized telemetry the runner's adapter produces; `payload` is that adapter's bounded,
 * pre-redacted view of the same message, for the retained timeline.
 */
export type AgentEvent = Readonly<{
  event: string
  timestamp: Date
  processId: number | null
  message: string | null
  usage: TokenCounts | null
  rateLimits: JsonObject | null
  threadId: string | null
  turnId: string | null
  sessionId: string | null
  turnCount: number
  turnStatus: string | null
  payload: AgentEventPayload
  /** What this event means for the session, or `null` when it reports no transition. */
  lifecycle: AgentLifecycle | null
}>

/**
 * One rate-limit window, as a runner reports it. Every field is tolerant and the record is
 * normalized to one casing by {@link protocolStruct}, so a backend reporting `used_percent` on one
 * message and `usedPercent` on the next is answered here rather than at each field read.
 *
 * This decodes the window's *shape* only. Redaction and bounding happen in {@link decodeRateLimits}
 * below, so no retained value is ever constructed before the redactor has seen it.
 */
const rateLimitWindowSource = protocolStruct({
  usedPercent: tolerant(finiteNumber),
  windowMinutes: tolerant(finiteNumber),
  resetsInSeconds: tolerant(finiteNumber),
})

const decodeRateLimitWindow = decodeOrNull(rateLimitWindowSource)
const decodeRateLimitReport = decodeOrNull(protocolRecord)

export const qualityPhaseOf = (command: string): QualityPhase | null => {
  const words = new Set(command.toLowerCase().split(/[^a-z]+/u))
  // `check` last: a composite quality command usually names the specific step as well, and the
  // specific step is the more useful label.
  return (
    qualityPhases.find((phase) => phase !== 'check' && words.has(phase)) ??
    (words.has('check') ? 'check' : null)
  )
}

export const decodeRateLimits = (value: JsonValue | undefined): readonly RateLimitWindow[] => {
  const report = decodeRateLimitReport(value)
  if (report === null) {
    return []
  }
  const windows: RateLimitWindow[] = []
  // The report's own keys name the windows, so they are not casing-normalized: a window is
  // whatever the server called it.
  for (const [name, window] of Object.entries(report)) {
    const decoded = decodeRateLimitWindow(window)
    if (decoded === null) {
      continue
    }
    windows.push({ name: bound(redact(name), 40).text, ...decoded })
  }
  // Frozen on construction, so the copies a timeline event and a published snapshot each hold
  // cannot be edited into the actor's own reading.
  return Object.freeze(
    windows
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((window) => Object.freeze(window)),
  )
}

export type AgentPhase =
  | 'starting'
  | 'reasoning'
  | 'responding'
  | 'running_tool'
  | 'running_command'
  | 'editing'
  | 'awaiting_model'
  | 'retrying'
  | 'handing_off'
  | 'cancelled'
  | 'stalled'

export type HandoffStep =
  | 'local_branch'
  | 'remote_branch'
  | 'pull_request'
  | 'dispatch_label'
  | 'outcome'

export type HandoffStepStatus = 'pending' | 'observed' | 'absent' | 'failed' | 'not_performed'

type TimelineBase = Readonly<{
  sequence: number
  attempt: number
  at: string
  event: string
  operation: string | null
  truncated: boolean
}>

export type AgentTimelineEvent =
  | (TimelineBase &
      Readonly<{
        category: 'session'
        threadId: string | null
        turnId: string | null
        sessionId: string | null
        turnNumber: number
        processId: number | null
      }>)
  | (TimelineBase & Readonly<{ category: 'reasoning' }>)
  | (TimelineBase & Readonly<{ category: 'message'; role: MessageRole; text: string | null }>)
  | (TimelineBase &
      Readonly<{
        category: 'tool'
        name: string
        state: ToolState
        inputBytes: number | null
        outputBytes: number | null
      }>)
  | (TimelineBase &
      Readonly<{
        category: 'file'
        path: string
        change: FileChangeKind
        addedLines: number | null
        deletedLines: number | null
      }>)
  | (TimelineBase &
      Readonly<{
        category: 'command'
        program: string
        argumentCount: number
        quality: QualityPhase | null
        state: ToolState
        exitCode: number | null
        durationMs: number | null
      }>)
  | (TimelineBase &
      Readonly<{
        category: 'usage'
        tokens: TokenCounts | null
        rateLimits: readonly RateLimitWindow[]
      }>)
  | (TimelineBase &
      Readonly<{
        category: 'retry'
        attemptNumber: number
        dueAt: string | null
        reason: string | null
      }>)
  | (TimelineBase &
      Readonly<{
        category: 'error'
        severity: ErrorSeverity
        code: string | null
        message: string
      }>)
  | (TimelineBase & Readonly<{ category: 'cancellation'; reason: string }>)
  | (TimelineBase &
      Readonly<{
        category: 'handoff'
        step: HandoffStep
        status: HandoffStepStatus
        message: string | null
      }>)

export type AgentTimelineCategory = AgentTimelineEvent['category']

export const timelineCategories: readonly AgentTimelineCategory[] = [
  'session',
  'reasoning',
  'message',
  'tool',
  'file',
  'command',
  'usage',
  'retry',
  'error',
  'cancellation',
  'handoff',
]

export type AgentSessionSummary = Readonly<{
  attempt: number
  threadId: string | null
  sessionId: string | null
  processId: number | null
  startedAt: string
  endedAt: string | null
}>

export type AgentAttemptSummary = Readonly<{
  attempt: number
  startedAt: string
  endedAt: string | null
  outcome: 'running' | 'retrying' | 'cancelled' | 'handed_off' | 'ended'
  reason: string | null
  firstSequence: number
  lastSequence: number
}>

export type AgentErrorSummary = Readonly<{
  at: string
  attempt: number
  severity: ErrorSeverity
  code: string | null
  message: string
}>

export type AgentWorkspaceSummary = Readonly<{
  pathKey: string
  branch: string | null
  dirtyFileCount: number
  addedLines: number
  deletedLines: number
  lastFileActivityAt: string | null
  qualityPhase: QualityPhase | null
  qualityCommandState: ToolState | null
  /** Whether the retained changed-path set hit its bound. */
  pathsTruncated: boolean
}>

export type AgentHandoffDetail = Readonly<{
  expectedBranch: string | null
  remoteBranch: Readonly<{ status: HandoffStepStatus; name: string | null }>
  pullRequest: Readonly<{
    status: 'pending' | 'created' | 'reused' | 'absent'
    number: number | null
    url: string | null
    state: string | null
  }>
  dispatchLabels: Readonly<{
    labels: readonly string[]
    status: HandoffStepStatus
    reason: string | null
  }>
  outcome:
    | 'in_progress'
    | 'no_branch'
    | 'pull_request_open'
    | 'merged'
    | 'intervention_required'
    | 'failed'
  reason: string | null
}>

export type AgentDetailStatus = 'running' | 'retrying' | 'completed'

export type AgentDetailSnapshot = Readonly<{
  version: 'v1'
  /** Stable self link, identical to the one published in the runtime snapshot. */
  self: string
  generatedAt: string
  issueId: string
  identifier: string
  title: string
  url: string | null
  status: AgentDetailStatus
  /**
   * Whether this host composes code-review services. With them, completed work is handed off as a
   * pull request; without them the core continuation lifecycle runs instead, and a console that
   * assumed the first would promise an operator an outcome that cannot happen.
   */
  handoffEnabled: boolean
  identity: Readonly<{
    threadId: string | null
    turnId: string | null
    sessionId: string | null
    processId: number | null
    turnNumber: number
    workerHost: string
  }>
  attempt: Readonly<{
    current: number
    retries: number
    attempts: readonly AgentAttemptSummary[]
    sessions: readonly AgentSessionSummary[]
  }>
  phase: Readonly<{ phase: AgentPhase; operation: string | null; since: string }>
  activity: Readonly<{
    startedAt: string
    lastActivityAt: string | null
    elapsedMs: number
    idleMs: number
    stallTimeoutMs: number
    stallDeadline: string | null
    stallCountdownMs: number | null
    stalled: boolean
  }>
  usage: TokenCounts
  rateLimits: readonly RateLimitWindow[]
  workspace: AgentWorkspaceSummary
  handoff: AgentHandoffDetail
  retry: Readonly<{ attempt: number; dueAt: string; reason: string | null }> | null
  errors: readonly AgentErrorSummary[]
  timeline: Readonly<{
    events: readonly AgentTimelineEvent[]
    retained: number
    dropped: number
    limit: number
  }>
}>

type ChangedPath = Readonly<{ addedLines: number; deletedLines: number; lastActivityAt: Date }>

/**
 * Actor-owned telemetry for one issue, as an immutable value. Every recorder folds one observation
 * into a new record instead of editing this one, so the actor can publish the record it holds
 * without copying it: a consumer that was handed an earlier value keeps exactly the reading it was
 * given, and no later update can reach it.
 *
 * The arrays and summaries a record adopts are frozen as they are built, which is what lets
 * {@link buildAgentDetail} share them rather than clone them.
 */
export type AgentDetailRecord = Readonly<{
  issueId: IssueId
  identifier: IssueIdentifier
  title: string
  url: string | null
  startedAt: Date
  attempt: number
  sequence: number
  /**
   * Attempts started beyond the first. Counted rather than derived from the retained attempt
   * summaries, which are bounded: a long-running failing issue would otherwise report a retry total
   * frozen at the retention limit while its attempt number kept climbing.
   */
  retries: number
  events: readonly AgentTimelineEvent[]
  dropped: number
  phase: AgentPhase
  phaseSince: Date
  operation: string | null
  lastActivityAt: Date | null
  threadId: string | null
  turnId: string | null
  sessionId: string | null
  processId: number | null
  turnCount: number
  tokens: TokenCounts
  rateLimits: readonly RateLimitWindow[]
  sessions: readonly AgentSessionSummary[]
  attempts: readonly AgentAttemptSummary[]
  errors: readonly AgentErrorSummary[]
  changedPaths: ReadonlyMap<string, ChangedPath>
  pathsTruncated: boolean
  addedLines: number
  deletedLines: number
  lastFileActivityAt: Date | null
  qualityPhase: QualityPhase | null
  qualityCommandState: ToolState | null
  workspacePathKey: string
  handoff: AgentHandoffDetail
}>

export type AgentDetailInput = Readonly<{
  issueId: IssueId
  identifier: IssueIdentifier
  title: string
  url: string | null
  attempt: number | null
  startedAt: Date
  workspacePathKey: string
  expectedBranch: string | null
  dispatchLabels: readonly string[]
}>

export const createAgentDetailRecord = (input: AgentDetailInput): AgentDetailRecord => ({
  issueId: input.issueId,
  identifier: input.identifier,
  title: input.title,
  url: input.url,
  startedAt: input.startedAt,
  attempt: input.attempt ?? 0,
  sequence: 0,
  retries: 0,
  events: Object.freeze([]),
  dropped: 0,
  phase: 'starting',
  phaseSince: input.startedAt,
  operation: null,
  lastActivityAt: null,
  threadId: null,
  turnId: null,
  sessionId: null,
  processId: null,
  turnCount: 0,
  tokens: Object.freeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  rateLimits: Object.freeze([]),
  sessions: Object.freeze([]),
  attempts: Object.freeze([
    Object.freeze({
      attempt: input.attempt ?? 0,
      startedAt: input.startedAt.toISOString(),
      endedAt: null,
      outcome: 'running' as const,
      reason: null,
      firstSequence: 1,
      lastSequence: 0,
    }),
  ]),
  errors: Object.freeze([]),
  changedPaths: new Map(),
  pathsTruncated: false,
  addedLines: 0,
  deletedLines: 0,
  lastFileActivityAt: null,
  qualityPhase: null,
  qualityCommandState: null,
  workspacePathKey: input.workspacePathKey,
  handoff: Object.freeze({
    expectedBranch: input.expectedBranch,
    remoteBranch: Object.freeze({ status: 'pending' as const, name: null }),
    pullRequest: Object.freeze({
      status: 'pending' as const,
      number: null,
      url: null,
      state: null,
    }),
    dispatchLabels: Object.freeze({
      labels: Object.freeze([...input.dispatchLabels]),
      status: 'not_performed' as const,
      // Stated rather than implied: the GitHub adapter hands work off by opening a pull request and
      // leaves the dispatch label in place, so an operator is not left waiting for a removal that
      // is never going to be observed.
      reason: 'The tracker adapter does not remove dispatch labels at handoff',
    }),
    outcome: 'in_progress' as const,
    reason: null,
  }),
})

/**
 * Restates the issue fields that the tracker can change between attempts. The rest of the record —
 * the timeline, the attempt history, the sequence — is what makes it worth keeping across them.
 */
export const recordIssueRefreshed = (
  record: AgentDetailRecord,
  issue: Readonly<{ title: string; url: string | null }>,
): AgentDetailRecord => ({ ...record, title: issue.title, url: issue.url })

/**
 * Appends one timeline event, bounded by {@link timelineEventLimit}, and extends the current
 * attempt's sequence span to cover it.
 *
 * The event carries the sequence that {@link nextSequence} drew from this record, and every
 * recorder appends exactly one event, so adopting it here is what advances the record's counter.
 */
const push = (record: AgentDetailRecord, event: AgentTimelineEvent): AgentDetailRecord => {
  const appended = [...record.events, Object.freeze(event)]
  const dropped = Math.max(appended.length - timelineEventLimit, 0)
  const attempt = record.attempts.at(-1)
  const attempts =
    attempt !== undefined && attempt.attempt === event.attempt
      ? Object.freeze([
          ...record.attempts.slice(0, -1),
          Object.freeze({
            ...attempt,
            firstSequence: attempt.lastSequence === 0 ? event.sequence : attempt.firstSequence,
            lastSequence: event.sequence,
          }),
        ])
      : record.attempts
  return {
    ...record,
    sequence: event.sequence,
    events: Object.freeze(dropped === 0 ? appended : appended.slice(-timelineEventLimit)),
    dropped: record.dropped + dropped,
    attempts,
  }
}

/** The sequence number the next appended event takes. */
const nextSequence = (record: AgentDetailRecord): number => record.sequence + 1

const setPhase = (
  record: AgentDetailRecord,
  phase: AgentPhase,
  operation: string | null,
  at: Date,
): AgentDetailRecord =>
  record.phase === phase
    ? { ...record, operation }
    : { ...record, phase, phaseSince: at, operation }

const noteError = (
  record: AgentDetailRecord,
  at: Date,
  severity: ErrorSeverity,
  code: string | null,
  message: string,
): AgentDetailRecord => {
  const errors = [
    ...record.errors,
    Object.freeze({ at: at.toISOString(), attempt: record.attempt, severity, code, message }),
  ]
  return {
    ...record,
    errors: Object.freeze(
      errors.length > retainedErrorLimit ? errors.slice(-retainedErrorLimit) : errors,
    ),
  }
}

const noteChangedPath = (
  record: AgentDetailRecord,
  path: string,
  addedLines: number | null,
  deletedLines: number | null,
  at: Date,
): AgentDetailRecord => {
  const existing = record.changedPaths.get(path)
  const truncated = existing === undefined && record.changedPaths.size >= changedPathLimit
  const changedPaths = truncated
    ? record.changedPaths
    : new Map(record.changedPaths).set(
        path,
        Object.freeze({
          addedLines: (existing?.addedLines ?? 0) + (addedLines ?? 0),
          deletedLines: (existing?.deletedLines ?? 0) + (deletedLines ?? 0),
          lastActivityAt: at,
        }),
      )
  return {
    ...record,
    changedPaths,
    pathsTruncated: record.pathsTruncated || truncated,
    addedLines: record.addedLines + (addedLines ?? 0),
    deletedLines: record.deletedLines + (deletedLines ?? 0),
    lastFileActivityAt: at,
  }
}

/** Opens a session summary for the identity the agent has just reported. */
const openSession = (record: AgentDetailRecord, at: Date): AgentDetailRecord => {
  const sessions = [
    ...record.sessions,
    Object.freeze({
      attempt: record.attempt,
      threadId: record.threadId,
      sessionId: record.sessionId,
      processId: record.processId,
      startedAt: at.toISOString(),
      endedAt: null,
    }),
  ]
  return {
    ...record,
    sessions: Object.freeze(
      sessions.length > retainedAttemptLimit ? sessions.slice(-retainedAttemptLimit) : sessions,
    ),
  }
}

const replaceLastSession = (
  record: AgentDetailRecord,
  summary: AgentSessionSummary,
): AgentDetailRecord => ({
  ...record,
  sessions: Object.freeze([...record.sessions.slice(0, -1), Object.freeze(summary)]),
})

/** Ends the open session summary, if one is still open. Closing an ended session changes nothing. */
const closeSession = (record: AgentDetailRecord, at: Date): AgentDetailRecord => {
  const open = record.sessions.at(-1)
  return open === undefined || open.endedAt !== null
    ? record
    : replaceLastSession(record, { ...open, endedAt: at.toISOString() })
}

/**
 * Keeps the retained session history on the same identity the record reports. A session is one turn
 * on a thread, so each turn is its own retained session, and the history is keyed on the composed
 * id rather than on whether a summary is still open: an event for the session the last summary
 * already names changes nothing, whether that summary is open or was ended by its turn.
 *
 * The first turn on a thread is the exception — it completes the summary `session_started` opened
 * while only the thread was known, because there was no session before that turn, only the thread
 * that would run it. Any other new identity ends whatever is still open and starts its own summary.
 */
const alignSession = (record: AgentDetailRecord, at: Date): AgentDetailRecord => {
  if (record.threadId === null) {
    return record
  }
  const last = record.sessions.at(-1)
  if (last === undefined) {
    return openSession(record, at)
  }
  if (last.threadId === record.threadId && last.sessionId === record.sessionId) {
    return record
  }
  if (
    last.endedAt === null &&
    last.threadId === record.threadId &&
    last.sessionId === record.threadId
  ) {
    return replaceLastSession(record, {
      ...last,
      sessionId: record.sessionId,
      processId: record.processId,
    })
  }
  return openSession(closeSession(record, at), at)
}

/**
 * Whether an event reports the end of the turn it names. A session is one turn, so its retained
 * summary ends here rather than whenever the next turn happens to start or the attempt is torn
 * down — the gap where a continuation decides whether to run again belongs to no session.
 */
const endsTurn = (event: AgentEvent): boolean => event.lifecycle?.phase === 'turn_settled'

const messageOperation = (text: string | null): string =>
  text === null || text.length === 0 ? 'Writing a reply' : `Replying: ${bound(text, 80).text}`

/** The turn half of a session identity, held by both the runtime snapshot and the agent detail. */
export type TurnIdentity = Readonly<{
  turnId: string | null
  sessionId: string | null
  turnCount: number
}>

/**
 * The turn identity a holder should carry after one event. A session id names a turn, so both
 * halves move together: an event from a turn the run has already moved past restores neither, and
 * the runtime snapshot and the agent detail can never disagree about which turn is current. The one
 * event carrying no turn at all is `session_started`, and it precedes every turn on the thread.
 *
 * Both holders reset the count when a new attempt opens its own connection, so a fresh session
 * starting again at turn one is never held back by the count the previous one reached.
 */
export const foldTurnIdentity = (held: TurnIdentity, event: AgentEvent): TurnIdentity => {
  const supersedes = event.turnId !== null && event.turnCount >= held.turnCount
  return {
    turnId: supersedes ? event.turnId : held.turnId,
    sessionId:
      supersedes || event.turnId === null ? (event.sessionId ?? held.sessionId) : held.sessionId,
    turnCount: Math.max(held.turnCount, event.turnCount),
  }
}

/**
 * Folds one normalized agent event into the record and returns the result. Every retained string
 * arrived already redacted and bounded from the parser; nothing here widens it.
 */
export const recordAgentEvent = (
  record: AgentDetailRecord,
  event: AgentEvent,
): AgentDetailRecord => {
  const at = event.timestamp
  // Turn count, token totals, and rate limits are already normalized by the client; this layer
  // consumes them rather than deriving its own. The same token counts reach the record and the
  // usage timeline event, and a timeline event is only frozen shallowly, so the object they share
  // is frozen here rather than left reachable through `events[i].tokens`.
  const reported: AgentDetailRecord = {
    ...record,
    lastActivityAt: at,
    processId: event.processId ?? record.processId,
    threadId: event.threadId ?? record.threadId,
    ...foldTurnIdentity(record, event),
    tokens: event.usage === null ? record.tokens : Object.freeze({ ...event.usage }),
    rateLimits: event.rateLimits === null ? record.rateLimits : decodeRateLimits(event.rateLimits),
  }
  // Every event, not only a session-scoped one: whichever event first reports a turn's identity
  // is the one the retained history has to follow, or the summaries drift from `identity`.
  const aligned = alignSession(reported, at)
  // Only the turn the record is actually on: a superseded turn reporting its end late names a
  // session that already closed, and must not end the one running now.
  const observed =
    endsTurn(event) && event.turnId !== null && event.turnId === aligned.turnId
      ? closeSession(aligned, at)
      : aligned
  const base = {
    sequence: nextSequence(observed),
    attempt: observed.attempt,
    at: at.toISOString(),
    event: event.event,
    truncated: false,
  }
  const payload = event.payload
  if (event.usage !== null || event.rateLimits !== null) {
    return push(observed, {
      ...base,
      operation: observed.operation,
      category: 'usage',
      tokens: event.usage === null ? null : observed.tokens,
      rateLimits: observed.rateLimits,
    })
  }
  switch (payload.kind) {
    case 'session': {
      const next =
        observed.phase === 'starting'
          ? setPhase(observed, 'awaiting_model', 'Waiting for the model', at)
          : observed
      return push(next, {
        ...base,
        operation: next.operation,
        category: 'session',
        // The timeline is a log of what arrived, so an entry names the turn its own event belongs
        // to. Only the record's current identity is folded forward: a superseded turn reporting
        // late is still recorded here against the turn that produced it, rather than being
        // relabelled as the turn running now. An event that carries no identity of its own — the
        // client's own session-level notices — takes the record's.
        threadId: event.threadId ?? next.threadId,
        turnId: event.turnId ?? next.turnId,
        sessionId: event.sessionId ?? next.sessionId,
        turnNumber: event.turnId === null ? next.turnCount : event.turnCount,
        processId: next.processId,
      })
    }
    case 'reasoning': {
      const next = setPhase(observed, 'reasoning', 'Thinking', at)
      return push(next, { ...base, operation: next.operation, category: 'reasoning' })
    }
    case 'message': {
      const next = setPhase(observed, 'responding', messageOperation(payload.text), at)
      return push(next, {
        ...base,
        truncated: payload.truncated,
        operation: next.operation,
        category: 'message',
        role: payload.role,
        text: payload.text,
      })
    }
    case 'tool': {
      // A finished tool call is not a running one. Leaving the phase at `running_tool` would keep
      // the inspector reporting "Calling …" for work that already returned, and eventually report
      // that finished call as stalled while the model is simply deciding what to do next.
      const next =
        payload.state === 'completed'
          ? setPhase(observed, 'awaiting_model', `Finished ${payload.name}`, at)
          : payload.state === 'failed'
            ? setPhase(observed, 'awaiting_model', `${payload.name} failed`, at)
            : setPhase(observed, 'running_tool', `Calling ${payload.name}`, at)
      return push(next, {
        ...base,
        operation: next.operation,
        category: 'tool',
        name: payload.name,
        state: payload.state,
        inputBytes: payload.inputBytes,
        outputBytes: payload.outputBytes,
      })
    }
    case 'command': {
      const quality =
        payload.quality === null
          ? observed
          : { ...observed, qualityPhase: payload.quality, qualityCommandState: payload.state }
      const exit = payload.exitCode === null ? '' : ` (exit ${String(payload.exitCode)})`
      const next =
        payload.state === 'completed'
          ? setPhase(quality, 'awaiting_model', `Finished ${payload.program}${exit}`, at)
          : payload.state === 'failed'
            ? setPhase(quality, 'awaiting_model', `${payload.program} failed${exit}`, at)
            : setPhase(quality, 'running_command', `Running ${payload.program}`, at)
      return push(next, {
        ...base,
        operation: next.operation,
        category: 'command',
        program: payload.program,
        argumentCount: payload.argumentCount,
        quality: payload.quality,
        state: payload.state,
        exitCode: payload.exitCode,
        durationMs: payload.durationMs,
      })
    }
    case 'file': {
      const changed = noteChangedPath(
        observed,
        payload.path,
        payload.addedLines,
        payload.deletedLines,
        at,
      )
      const next = setPhase(changed, 'editing', `Editing ${payload.path}`, at)
      return push(next, {
        ...base,
        operation: next.operation,
        category: 'file',
        path: payload.path,
        change: payload.change,
        addedLines: payload.addedLines,
        deletedLines: payload.deletedLines,
      })
    }
    case 'error': {
      const next = noteError(observed, at, payload.severity, payload.code, payload.message)
      return push(next, {
        ...base,
        truncated: payload.truncated,
        operation: next.operation,
        category: 'error',
        severity: payload.severity,
        code: payload.code,
        message: payload.message,
      })
    }
    case 'cancellation': {
      const next = setPhase(observed, 'cancelled', payload.reason, at)
      return push(next, {
        ...base,
        operation: next.operation,
        category: 'cancellation',
        reason: payload.reason,
      })
    }
    case 'none': {
      // An unrecognized message is still evidence of life, so it is retained by method name only.
      return push(observed, {
        ...base,
        operation: observed.operation,
        category: 'session',
        threadId: observed.threadId,
        turnId: observed.turnId,
        sessionId: observed.sessionId,
        turnNumber: observed.turnCount,
        processId: observed.processId,
      })
    }
  }
}

/**
 * Closes the current attempt and, when a session is open, marks it ended.
 *
 * `relabel` re-states the outcome of an attempt that has already ended, keeping the moment it ended.
 * Scheduling a retry is the latest and most specific word on how an attempt turned out — later than
 * the cancellation or failed handoff that closed it moments earlier — so that path corrects the
 * label rather than leaving the attempt history claiming an ending that did not hold.
 */
const endAttempt = (
  record: AgentDetailRecord,
  at: Date,
  outcome: AgentAttemptSummary['outcome'],
  reason: string | null,
  relabel = false,
): AgentDetailRecord => {
  const attempt = record.attempts.at(-1)
  const attempts =
    attempt !== undefined && (attempt.endedAt === null || relabel)
      ? Object.freeze([
          ...record.attempts.slice(0, -1),
          Object.freeze({
            ...attempt,
            endedAt: attempt.endedAt ?? at.toISOString(),
            outcome,
            reason,
          }),
        ])
      : record.attempts
  const session = record.sessions.at(-1)
  const sessions =
    session !== undefined && session.endedAt === null
      ? Object.freeze([
          ...record.sessions.slice(0, -1),
          Object.freeze({ ...session, endedAt: at.toISOString() }),
        ])
      : record.sessions
  return { ...record, attempts, sessions }
}

/**
 * Records a scheduled retry. The attempt boundary is explicit on the timeline, and the sequence
 * keeps rising, so ordering and session identity survive the boundary that separates the attempts.
 */
export const recordRetryScheduled = (
  record: AgentDetailRecord,
  at: Date,
  attemptNumber: number,
  dueAt: Date,
  reason: string | null,
): AgentDetailRecord => {
  const summary = reason === null ? null : boundRedacted(reason).text
  const ended = endAttempt(record, at, 'retrying', summary, true)
  const next = setPhase(ended, 'retrying', summary ?? 'Waiting to retry', at)
  const pushed = push(next, {
    sequence: nextSequence(next),
    attempt: next.attempt,
    at: at.toISOString(),
    event: 'retry/scheduled',
    operation: next.operation,
    truncated: false,
    category: 'retry',
    attemptNumber,
    dueAt: dueAt.toISOString(),
    reason: summary,
  })
  return summary === null ? pushed : noteError(pushed, at, 'error', 'retry', summary)
}

/** Opens a new attempt for the same issue, preserving the timeline that led to it. */
export const recordAttemptStarted = (
  record: AgentDetailRecord,
  at: Date,
  attemptNumber: number,
): AgentDetailRecord => {
  const attempts = [
    ...record.attempts,
    Object.freeze({
      attempt: attemptNumber,
      startedAt: at.toISOString(),
      endedAt: null,
      outcome: 'running' as const,
      reason: null,
      firstSequence: record.sequence + 1,
      lastSequence: record.sequence,
    }),
  ]
  // A new attempt is a new agent connection, so every session-scoped field is cleared rather than
  // left to describe the previous one: identity is only refilled by events the new session emits,
  // and the turn count starts over — it is folded forward with `Math.max`, so a session beginning
  // again at turn one could never displace a larger count carried over from the last. The session
  // this replaces is preserved in full by the retained session summaries.
  const started: AgentDetailRecord = {
    ...record,
    attempt: attemptNumber,
    retries: record.retries + 1,
    startedAt: at,
    lastActivityAt: null,
    threadId: null,
    turnId: null,
    sessionId: null,
    processId: null,
    turnCount: 0,
    attempts: Object.freeze(
      attempts.length > retainedAttemptLimit ? attempts.slice(-retainedAttemptLimit) : attempts,
    ),
  }
  const next = setPhase(started, 'starting', 'Starting the agent', at)
  return push(next, {
    sequence: nextSequence(next),
    attempt: attemptNumber,
    at: at.toISOString(),
    event: 'attempt/started',
    operation: next.operation,
    truncated: false,
    category: 'session',
    threadId: next.threadId,
    turnId: null,
    sessionId: next.sessionId,
    turnNumber: next.turnCount,
    processId: next.processId,
  })
}

/**
 * Records a cancellation. A queued retry that is dropped before it runs has already closed its
 * attempt as `retrying`, so that outcome is relabelled rather than left contradicting the
 * cancelled phase; a cancellation of a live attempt closes the still-open attempt as usual.
 */
export const recordCancellation = (
  record: AgentDetailRecord,
  at: Date,
  reason: string,
  relabelEndedAttempt = false,
): AgentDetailRecord => {
  const summary = boundRedacted(reason).text
  const ended = endAttempt(record, at, 'cancelled', summary, relabelEndedAttempt)
  const next = setPhase(ended, /stall/iu.test(reason) ? 'stalled' : 'cancelled', summary, at)
  return push(next, {
    sequence: nextSequence(next),
    attempt: next.attempt,
    at: at.toISOString(),
    event: 'agent/cancelled',
    operation: next.operation,
    truncated: false,
    category: 'cancellation',
    reason: summary,
  })
}

export type HandoffObservation = Readonly<{
  step: HandoffStep
  status: HandoffStepStatus
  message: string | null
  remoteBranch?: string | null
  pullRequest?: Readonly<{
    status: 'created' | 'reused' | 'absent'
    number: number | null
    url: string | null
    state: string | null
  }>
  outcome?: AgentHandoffDetail['outcome']
}>

/** The handoff outcomes that end an attempt rather than being followed by another one. */
const handedOffOutcomes: ReadonlySet<AgentHandoffDetail['outcome']> = new Set([
  'pull_request_open',
  'merged',
  'intervention_required',
])

export const recordHandoff = (
  record: AgentDetailRecord,
  at: Date,
  observation: HandoffObservation,
): AgentDetailRecord => {
  const summary = observation.message === null ? null : boundRedacted(observation.message).text
  const handoff: AgentHandoffDetail = Object.freeze({
    ...record.handoff,
    remoteBranch:
      observation.remoteBranch === undefined
        ? record.handoff.remoteBranch
        : Object.freeze({ status: observation.status, name: observation.remoteBranch }),
    pullRequest:
      observation.pullRequest === undefined
        ? record.handoff.pullRequest
        : Object.freeze({ ...observation.pullRequest }),
    outcome: observation.outcome ?? record.handoff.outcome,
    reason: summary,
  })
  // Only an outcome that actually ends the work closes the attempt. A missing branch or a failed
  // handoff is followed by another attempt, so closing it here would label a retrying attempt as
  // handed off — and the retry that follows could no longer correct it.
  const observed: AgentDetailRecord = { ...record, handoff }
  const ended =
    observation.outcome !== undefined && handedOffOutcomes.has(observation.outcome)
      ? endAttempt(observed, at, 'handed_off', summary)
      : observed
  const next = setPhase(ended, 'handing_off', summary ?? 'Handing off completed work', at)
  return push(next, {
    sequence: nextSequence(next),
    attempt: next.attempt,
    at: at.toISOString(),
    event: `handoff/${observation.step}`,
    operation: next.operation,
    truncated: false,
    category: 'handoff',
    step: observation.step,
    status: observation.status,
    message: summary,
  })
}

export type AgentDetailContext = Readonly<{
  self: string
  now: Date
  status: AgentDetailStatus
  stallTimeoutMs: number
  workerHost: string
  /** Whether the execution behind this agent has a code-review port to hand its work off to. */
  handoffEnabled: boolean
  branch: string | null
  retry: Readonly<{ attempt: number; dueAt: Date; reason: string | null }> | null
}>

/**
 * Builds the exact, immutable snapshot published to operator consumers.
 *
 * Only the objects assembled here are frozen. Everything taken straight from the record — the
 * timeline, the attempt and session histories, the retained errors, the rate-limit windows, the
 * token counts, and the handoff detail — was frozen as the record adopted it and is shared rather
 * than copied: the record is a value that no recorder edits, so there is nothing for a consumer to
 * observe changing underneath it and nothing reachable to write through.
 */
export const buildAgentDetail = (
  record: AgentDetailRecord,
  context: AgentDetailContext,
): AgentDetailSnapshot => {
  const now = context.now.getTime()
  const activeAt = record.lastActivityAt ?? record.startedAt
  const idleMs = Math.max(now - activeAt.getTime(), 0)
  // An agent that has been cancelled, is waiting to retry, or is handing off is not working, so
  // silence from it is expected rather than evidence of a stall.
  const settledPhase =
    record.phase === 'cancelled' || record.phase === 'retrying' || record.phase === 'handing_off'
  const stallDeadline =
    context.stallTimeoutMs > 0 && context.status === 'running' && !settledPhase
      ? new Date(activeAt.getTime() + context.stallTimeoutMs)
      : null
  const stalled = stallDeadline !== null && stallDeadline.getTime() <= now
  const phase: AgentPhase = stalled ? 'stalled' : record.phase
  return Object.freeze({
    version: 'v1',
    self: context.self,
    generatedAt: context.now.toISOString(),
    issueId: record.issueId,
    identifier: record.identifier,
    title: record.title,
    url: record.url,
    status: context.status,
    handoffEnabled: context.handoffEnabled,
    identity: Object.freeze({
      threadId: record.threadId,
      turnId: record.turnId,
      sessionId: record.sessionId,
      processId: record.processId,
      turnNumber: record.turnCount,
      workerHost: context.workerHost,
    }),
    attempt: Object.freeze({
      current: record.attempt,
      retries: record.retries,
      attempts: record.attempts,
      sessions: record.sessions,
    }),
    phase: Object.freeze({
      phase,
      operation: record.operation,
      since: (stalled && stallDeadline !== null ? stallDeadline : record.phaseSince).toISOString(),
    }),
    activity: Object.freeze({
      startedAt: record.startedAt.toISOString(),
      lastActivityAt: record.lastActivityAt?.toISOString() ?? null,
      elapsedMs: Math.max(now - record.startedAt.getTime(), 0),
      idleMs,
      stallTimeoutMs: context.stallTimeoutMs,
      stallDeadline: stallDeadline?.toISOString() ?? null,
      stallCountdownMs: stallDeadline === null ? null : Math.max(stallDeadline.getTime() - now, 0),
      stalled,
    }),
    usage: record.tokens,
    rateLimits: record.rateLimits,
    workspace: Object.freeze({
      pathKey: record.workspacePathKey,
      branch: context.branch ?? record.handoff.expectedBranch,
      dirtyFileCount: record.changedPaths.size,
      addedLines: record.addedLines,
      deletedLines: record.deletedLines,
      lastFileActivityAt: record.lastFileActivityAt?.toISOString() ?? null,
      qualityPhase: record.qualityPhase,
      qualityCommandState: record.qualityCommandState,
      pathsTruncated: record.pathsTruncated,
    }),
    handoff: record.handoff,
    retry:
      context.retry === null
        ? null
        : Object.freeze({
            attempt: context.retry.attempt,
            dueAt: context.retry.dueAt.toISOString(),
            reason: context.retry.reason === null ? null : boundRedacted(context.retry.reason).text,
          }),
    errors: record.errors,
    timeline: Object.freeze({
      events: record.events,
      retained: record.events.length,
      dropped: record.dropped,
      limit: timelineEventLimit,
    }),
  })
}
