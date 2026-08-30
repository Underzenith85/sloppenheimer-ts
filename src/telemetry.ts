/**
 * Canonical agent session telemetry.
 *
 * One pipeline carries everything an operator can see about a live agent: the Codex client
 * normalizes each protocol message into a bounded, already-redacted {@link AgentEventPayload}, and
 * the orchestrator folds those payloads — plus the scheduling facts only it knows, such as retries,
 * cancellations, and pull-request handoff — into an actor-owned {@link AgentDetailRecord}. The
 * record is never read directly by a consumer; the actor publishes exact, immutable
 * {@link AgentDetailSnapshot} values built from it.
 */

import type { IssueId, IssueIdentifier, JsonObject, JsonValue } from './domain.js'
import { isJsonArray, isJsonObject } from './json.js'
import {
  bound,
  boundRedacted,
  commandSummary,
  pathKey,
  redact,
  type Redactor,
} from './redaction.js'

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

/**
 * The canonical session event. Identity, token totals, rate limits, turn count, and turn status are
 * the normalized telemetry the Codex client already produces; `payload` is this module's bounded,
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
}>

const noPayload: AgentEventPayload = Object.freeze({ kind: 'none' })

const numberOf = (value: JsonValue | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const stringOf = (value: JsonValue | undefined): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const firstNumber = (source: JsonObject, keys: readonly string[]): number | null => {
  for (const key of keys) {
    const value = numberOf(source[key])
    if (value !== null) {
      return value
    }
  }
  return null
}

const firstString = (source: JsonObject, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = stringOf(source[key])
    if (value !== null) {
      return value
    }
  }
  return null
}

/** The size of a payload we deliberately do not retain, so an operator still sees its scale. */
const byteLength = (value: JsonValue | undefined): number | null => {
  if (value === undefined) {
    return null
  }
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return null
  }
}

export const qualityPhaseOf = (command: string): QualityPhase | null => {
  const words = new Set(command.toLowerCase().split(/[^a-z]+/u))
  // `check` last: a composite quality command usually names the specific step as well, and the
  // specific step is the more useful label.
  return (
    qualityPhases.find((phase) => phase !== 'check' && words.has(phase)) ??
    (words.has('check') ? 'check' : null)
  )
}

const commandText = (value: JsonValue | undefined): string | null => {
  if (typeof value === 'string') {
    return value
  }
  if (isJsonArray(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string')
    return parts.length === 0 ? null : parts.join(' ')
  }
  return null
}

export const decodeRateLimits = (value: JsonValue | undefined): readonly RateLimitWindow[] => {
  if (!isJsonObject(value)) {
    return []
  }
  const windows: RateLimitWindow[] = []
  for (const [name, window] of Object.entries(value)) {
    if (!isJsonObject(window)) {
      continue
    }
    windows.push({
      name: bound(redact(name), 40).text,
      usedPercent: firstNumber(window, ['usedPercent', 'used_percent']),
      windowMinutes: firstNumber(window, ['windowMinutes', 'window_minutes']),
      resetsInSeconds: firstNumber(window, ['resetsInSeconds', 'resets_in_seconds']),
    })
  }
  // Frozen on construction, so the copies a timeline event and a published snapshot each hold
  // cannot be edited into the actor's own reading.
  return Object.freeze(
    windows
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((window) => Object.freeze(window)),
  )
}

const itemState = (method: string, item: JsonObject): ToolState => {
  const status = firstString(item, ['status', 'state'])?.toLowerCase() ?? null
  if (status === 'failed' || status === 'error') {
    return 'failed'
  }
  if (status === 'completed' || status === 'succeeded' || method.endsWith('/completed')) {
    return 'completed'
  }
  return 'started'
}

const fileChangeKinds = new Map<string, FileChangeKind>([
  ['add', 'add'],
  ['added', 'add'],
  ['create', 'add'],
  ['created', 'add'],
  ['delete', 'delete'],
  ['deleted', 'delete'],
  ['remove', 'delete'],
  ['removed', 'delete'],
  ['update', 'update'],
  ['updated', 'update'],
  ['modify', 'update'],
  ['modified', 'update'],
])

const changeKind = (value: string | null): FileChangeKind =>
  fileChangeKinds.get(value?.toLowerCase() ?? '') ?? 'unknown'

const fileTarget = (item: JsonObject): JsonObject => {
  const changes = item['changes']
  if (isJsonArray(changes)) {
    const first = changes[0]
    if (isJsonObject(first)) {
      return first
    }
  }
  return item
}

const itemPayload = (
  method: string,
  item: JsonObject,
  redactor: Redactor,
): AgentEventPayload | null => {
  const type = (firstString(item, ['type', 'itemType', 'item_type']) ?? '').toLowerCase()
  if (type.includes('reasoning')) {
    // Private reasoning is never retained, not even truncated: the fact that the agent is thinking
    // is the whole of the signal an operator is entitled to.
    return { kind: 'reasoning' }
  }
  if (type.includes('message')) {
    const raw = firstString(item, ['text', 'content', 'message'])
    const summary = raw === null ? null : boundRedacted(raw, redactor)
    return {
      kind: 'message',
      role: type.includes('user') ? 'user' : 'assistant',
      text: summary?.text ?? null,
      truncated: summary?.truncated ?? false,
    }
  }
  if (type.includes('command') || type.includes('exec') || type.includes('shell')) {
    const raw = commandText(item['command'] ?? item['commandLine'])
    const summary = commandSummary(raw ?? 'unknown', redactor)
    return {
      kind: 'command',
      program: summary.program,
      argumentCount: summary.argumentCount,
      quality: raw === null ? null : qualityPhaseOf(raw),
      state: itemState(method, item),
      exitCode: firstNumber(item, ['exitCode', 'exit_code']),
      durationMs: firstNumber(item, ['durationMs', 'duration_ms']),
    }
  }
  if (type.includes('file') || type.includes('patch') || type.includes('diff')) {
    const target = fileTarget(item)
    const path = firstString(target, ['path', 'file', 'filePath', 'file_path'])
    return {
      kind: 'file',
      path: path === null ? 'unknown' : pathKey(redactor(path)),
      change: changeKind(firstString(target, ['kind', 'type', 'change', 'changeKind'])),
      addedLines: firstNumber(target, ['addedLines', 'added_lines', 'additions']),
      deletedLines: firstNumber(target, ['deletedLines', 'deleted_lines', 'deletions']),
    }
  }
  if (type.includes('tool') || type.includes('search') || type.includes('mcp')) {
    return {
      kind: 'tool',
      name: bound(redactor(firstString(item, ['name', 'tool', 'server']) ?? 'tool'), 80).text,
      state: itemState(method, item),
      // Tool arguments and results routinely carry file contents and credentials, so only their
      // scale is kept.
      inputBytes: byteLength(item['input'] ?? item['arguments'] ?? item['args']),
      outputBytes: byteLength(item['output'] ?? item['result']),
    }
  }
  if (type.includes('error')) {
    const summary = boundRedacted(firstString(item, ['message', 'error']) ?? method, redactor)
    return {
      kind: 'error',
      severity: 'error',
      code: firstString(item, ['code']),
      message: summary.text,
      truncated: summary.truncated,
    }
  }
  return null
}

/**
 * Normalizes one App Server message into the bounded payload the timeline retains. Anything not
 * recognized degrades to `none`: an unknown message still appears on the timeline by method name,
 * which is safe, rather than being retained verbatim, which is not.
 */
export const normalizePayload = (
  method: string,
  params: JsonValue | undefined,
  redactor: Redactor = redact,
): AgentEventPayload => {
  const source = isJsonObject(params) ? params : null
  if (source !== null) {
    const item = source['item']
    if (isJsonObject(item)) {
      const payload = itemPayload(method, item, redactor)
      if (payload !== null) {
        return payload
      }
    }
    const text = stringOf(source['text'] ?? source['message'])
    if (text !== null && /message/iu.test(method)) {
      const summary = boundRedacted(text, redactor)
      return {
        kind: 'message',
        role: 'assistant',
        text: summary.text,
        truncated: summary.truncated,
      }
    }
  }
  if (/^thread\/|^session\/|^turn\//u.test(method)) {
    return { kind: 'session' }
  }
  return noPayload
}

/** The payload for a message the client itself emits about the session. */
export const clientPayload = (
  event: string,
  message: string | null,
  redactor: Redactor = redact,
): AgentEventPayload => {
  const summary = boundRedacted(message ?? event, redactor)
  switch (event) {
    case 'session_started':
    case 'session_stopped':
    case 'thread_started':
    case 'turn_started':
    case 'turn/terminated': {
      return { kind: 'session' }
    }
    case 'approval_auto_approved': {
      return {
        kind: 'tool',
        name: summary.text,
        state: 'approved',
        inputBytes: null,
        outputBytes: null,
      }
    }
    case 'permissions_grant_withheld': {
      return {
        kind: 'tool',
        name: summary.text,
        state: 'withheld',
        inputBytes: null,
        outputBytes: null,
      }
    }
    default: {
      return {
        kind: 'error',
        // Client-side notices — stderr noise, an unmatched response, a message Symphony could not
        // decode — are reported, but they are not by themselves session failures.
        severity: 'warning',
        code: event,
        message: summary.text,
        truncated: summary.truncated,
      }
    }
  }
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

/**
 * Publishes an array whose elements a consumer cannot reach back through. Freezing only the array
 * would leave every element shared with the actor's own record, so a cast consumer could edit one
 * in place and have the actor carry that edit forward on its next update.
 */
const frozen = <Value extends object>(values: readonly Value[]): readonly Value[] =>
  Object.freeze(values.map((value) => Object.freeze({ ...value })))

type ChangedPath = { addedLines: number; deletedLines: number; lastActivityAt: Date }

/**
 * Actor-owned mutable telemetry for one issue. Only the orchestrator's event loop touches it, and
 * only {@link buildAgentDetail} leaves it — as a frozen value, so no consumer can observe a partial
 * update or reach the scheduler's own state through the snapshot it was handed.
 */
export type AgentDetailRecord = {
  readonly issueId: IssueId
  readonly identifier: IssueIdentifier
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
  events: AgentTimelineEvent[]
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
  sessions: AgentSessionSummary[]
  attempts: AgentAttemptSummary[]
  errors: AgentErrorSummary[]
  changedPaths: Map<string, ChangedPath>
  pathsTruncated: boolean
  addedLines: number
  deletedLines: number
  lastFileActivityAt: Date | null
  qualityPhase: QualityPhase | null
  qualityCommandState: ToolState | null
  workspacePathKey: string
  handoff: {
    expectedBranch: string | null
    remoteBranch: { status: HandoffStepStatus; name: string | null }
    pullRequest: {
      status: 'pending' | 'created' | 'reused' | 'absent'
      number: number | null
      url: string | null
      state: string | null
    }
    dispatchLabels: { labels: readonly string[]; status: HandoffStepStatus; reason: string | null }
    outcome: AgentHandoffDetail['outcome']
    reason: string | null
  }
}

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
  events: [],
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
  tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  rateLimits: [],
  sessions: [],
  attempts: [
    {
      attempt: input.attempt ?? 0,
      startedAt: input.startedAt.toISOString(),
      endedAt: null,
      outcome: 'running',
      reason: null,
      firstSequence: 1,
      lastSequence: 0,
    },
  ],
  errors: [],
  changedPaths: new Map(),
  pathsTruncated: false,
  addedLines: 0,
  deletedLines: 0,
  lastFileActivityAt: null,
  qualityPhase: null,
  qualityCommandState: null,
  workspacePathKey: input.workspacePathKey,
  handoff: {
    expectedBranch: input.expectedBranch,
    remoteBranch: { status: 'pending', name: null },
    pullRequest: { status: 'pending', number: null, url: null, state: null },
    dispatchLabels: {
      labels: [...input.dispatchLabels],
      status: 'not_performed',
      // Stated rather than implied: the GitHub adapter hands work off by opening a pull request and
      // leaves the dispatch label in place, so an operator is not left waiting for a removal that
      // is never going to be observed.
      reason: 'The tracker adapter does not remove dispatch labels at handoff',
    },
    outcome: 'in_progress',
    reason: null,
  },
})

const push = (record: AgentDetailRecord, event: AgentTimelineEvent): void => {
  record.events.push(Object.freeze(event))
  if (record.events.length > timelineEventLimit) {
    record.dropped += record.events.length - timelineEventLimit
    record.events = record.events.slice(-timelineEventLimit)
  }
  const attempt = record.attempts.at(-1)
  if (attempt !== undefined && attempt.attempt === event.attempt) {
    record.attempts[record.attempts.length - 1] = {
      ...attempt,
      firstSequence: attempt.lastSequence === 0 ? event.sequence : attempt.firstSequence,
      lastSequence: event.sequence,
    }
  }
}

const nextSequence = (record: AgentDetailRecord): number => {
  record.sequence += 1
  return record.sequence
}

const setPhase = (
  record: AgentDetailRecord,
  phase: AgentPhase,
  operation: string | null,
  at: Date,
): void => {
  if (record.phase !== phase) {
    record.phase = phase
    record.phaseSince = at
  }
  record.operation = operation
}

const noteError = (
  record: AgentDetailRecord,
  at: Date,
  severity: ErrorSeverity,
  code: string | null,
  message: string,
): void => {
  record.errors.push({
    at: at.toISOString(),
    attempt: record.attempt,
    severity,
    code,
    message,
  })
  if (record.errors.length > retainedErrorLimit) {
    record.errors = record.errors.slice(-retainedErrorLimit)
  }
}

const noteChangedPath = (
  record: AgentDetailRecord,
  path: string,
  addedLines: number | null,
  deletedLines: number | null,
  at: Date,
): void => {
  const existing = record.changedPaths.get(path)
  if (existing === undefined && record.changedPaths.size >= changedPathLimit) {
    record.pathsTruncated = true
  } else {
    record.changedPaths.set(path, {
      addedLines: (existing?.addedLines ?? 0) + (addedLines ?? 0),
      deletedLines: (existing?.deletedLines ?? 0) + (deletedLines ?? 0),
      lastActivityAt: at,
    })
  }
  record.addedLines += addedLines ?? 0
  record.deletedLines += deletedLines ?? 0
  record.lastFileActivityAt = at
}

const messageOperation = (text: string | null): string =>
  text === null || text.length === 0 ? 'Writing a reply' : `Replying: ${bound(text, 80).text}`

/**
 * Folds one normalized agent event into the record. Every retained string arrived already redacted
 * and bounded from the parser; nothing here widens it.
 */
export const recordAgentEvent = (record: AgentDetailRecord, event: AgentEvent): void => {
  const at = event.timestamp
  record.lastActivityAt = at
  record.processId = event.processId ?? record.processId
  record.threadId = event.threadId ?? record.threadId
  record.turnId = event.turnId ?? record.turnId
  record.sessionId = event.sessionId ?? record.sessionId
  // Turn count, token totals, and rate limits are already normalized by the client; this layer
  // consumes them rather than deriving its own.
  record.turnCount = Math.max(record.turnCount, event.turnCount)
  if (event.usage !== null) {
    record.tokens = event.usage
  }
  if (event.rateLimits !== null) {
    record.rateLimits = decodeRateLimits(event.rateLimits)
  }
  const base = {
    sequence: nextSequence(record),
    attempt: record.attempt,
    at: at.toISOString(),
    event: event.event,
    truncated: false,
  }
  const payload = event.payload
  if (event.usage !== null || event.rateLimits !== null) {
    push(record, {
      ...base,
      operation: record.operation,
      category: 'usage',
      tokens: event.usage,
      rateLimits: record.rateLimits,
    })
    return
  }
  switch (payload.kind) {
    case 'session': {
      if (record.threadId !== null && record.sessions.at(-1)?.threadId !== record.threadId) {
        record.sessions.push({
          attempt: record.attempt,
          threadId: record.threadId,
          sessionId: record.sessionId,
          processId: record.processId,
          startedAt: at.toISOString(),
          endedAt: null,
        })
        if (record.sessions.length > retainedAttemptLimit) {
          record.sessions = record.sessions.slice(-retainedAttemptLimit)
        }
      }
      if (record.phase === 'starting') {
        setPhase(record, 'awaiting_model', 'Waiting for the model', at)
      }
      push(record, {
        ...base,
        operation: record.operation,
        category: 'session',
        threadId: record.threadId,
        turnId: record.turnId,
        sessionId: record.sessionId,
        turnNumber: record.turnCount,
        processId: record.processId,
      })
      return
    }
    case 'reasoning': {
      setPhase(record, 'reasoning', 'Thinking', at)
      push(record, { ...base, operation: record.operation, category: 'reasoning' })
      return
    }
    case 'message': {
      setPhase(record, 'responding', messageOperation(payload.text), at)
      push(record, {
        ...base,
        truncated: payload.truncated,
        operation: record.operation,
        category: 'message',
        role: payload.role,
        text: payload.text,
      })
      return
    }
    case 'tool': {
      // A finished tool call is not a running one. Leaving the phase at `running_tool` would keep
      // the inspector reporting "Calling …" for work that already returned, and eventually report
      // that finished call as stalled while the model is simply deciding what to do next.
      if (payload.state === 'completed') {
        setPhase(record, 'awaiting_model', `Finished ${payload.name}`, at)
      } else if (payload.state === 'failed') {
        setPhase(record, 'awaiting_model', `${payload.name} failed`, at)
      } else {
        setPhase(record, 'running_tool', `Calling ${payload.name}`, at)
      }
      push(record, {
        ...base,
        operation: record.operation,
        category: 'tool',
        name: payload.name,
        state: payload.state,
        inputBytes: payload.inputBytes,
        outputBytes: payload.outputBytes,
      })
      return
    }
    case 'command': {
      if (payload.quality !== null) {
        record.qualityPhase = payload.quality
        record.qualityCommandState = payload.state
      }
      const exit = payload.exitCode === null ? '' : ` (exit ${String(payload.exitCode)})`
      if (payload.state === 'completed') {
        setPhase(record, 'awaiting_model', `Finished ${payload.program}${exit}`, at)
      } else if (payload.state === 'failed') {
        setPhase(record, 'awaiting_model', `${payload.program} failed${exit}`, at)
      } else {
        setPhase(record, 'running_command', `Running ${payload.program}`, at)
      }
      push(record, {
        ...base,
        operation: record.operation,
        category: 'command',
        program: payload.program,
        argumentCount: payload.argumentCount,
        quality: payload.quality,
        state: payload.state,
        exitCode: payload.exitCode,
        durationMs: payload.durationMs,
      })
      return
    }
    case 'file': {
      noteChangedPath(record, payload.path, payload.addedLines, payload.deletedLines, at)
      setPhase(record, 'editing', `Editing ${payload.path}`, at)
      push(record, {
        ...base,
        operation: record.operation,
        category: 'file',
        path: payload.path,
        change: payload.change,
        addedLines: payload.addedLines,
        deletedLines: payload.deletedLines,
      })
      return
    }
    case 'error': {
      noteError(record, at, payload.severity, payload.code, payload.message)
      push(record, {
        ...base,
        truncated: payload.truncated,
        operation: record.operation,
        category: 'error',
        severity: payload.severity,
        code: payload.code,
        message: payload.message,
      })
      return
    }
    case 'cancellation': {
      setPhase(record, 'cancelled', payload.reason, at)
      push(record, {
        ...base,
        operation: record.operation,
        category: 'cancellation',
        reason: payload.reason,
      })
      return
    }
    case 'none': {
      // An unrecognized message is still evidence of life, so it is retained by method name only.
      push(record, {
        ...base,
        operation: record.operation,
        category: 'session',
        threadId: record.threadId,
        turnId: record.turnId,
        sessionId: record.sessionId,
        turnNumber: record.turnCount,
        processId: record.processId,
      })
      return
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
): void => {
  const attempt = record.attempts.at(-1)
  if (attempt !== undefined && (attempt.endedAt === null || relabel)) {
    record.attempts[record.attempts.length - 1] = {
      ...attempt,
      endedAt: attempt.endedAt ?? at.toISOString(),
      outcome,
      reason,
    }
  }
  const session = record.sessions.at(-1)
  if (session !== undefined && session.endedAt === null) {
    record.sessions[record.sessions.length - 1] = { ...session, endedAt: at.toISOString() }
  }
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
): void => {
  const summary = reason === null ? null : boundRedacted(reason).text
  endAttempt(record, at, 'retrying', summary, true)
  setPhase(record, 'retrying', summary ?? 'Waiting to retry', at)
  push(record, {
    sequence: nextSequence(record),
    attempt: record.attempt,
    at: at.toISOString(),
    event: 'retry/scheduled',
    operation: record.operation,
    truncated: false,
    category: 'retry',
    attemptNumber,
    dueAt: dueAt.toISOString(),
    reason: summary,
  })
  if (summary !== null) {
    noteError(record, at, 'error', 'retry', summary)
  }
}

/** Opens a new attempt for the same issue, preserving the timeline that led to it. */
export const recordAttemptStarted = (
  record: AgentDetailRecord,
  at: Date,
  attemptNumber: number,
): void => {
  record.attempt = attemptNumber
  record.retries += 1
  record.startedAt = at
  record.lastActivityAt = null
  record.turnId = null
  record.attempts.push({
    attempt: attemptNumber,
    startedAt: at.toISOString(),
    endedAt: null,
    outcome: 'running',
    reason: null,
    firstSequence: record.sequence + 1,
    lastSequence: record.sequence,
  })
  if (record.attempts.length > retainedAttemptLimit) {
    record.attempts = record.attempts.slice(-retainedAttemptLimit)
  }
  setPhase(record, 'starting', 'Starting the agent', at)
  push(record, {
    sequence: nextSequence(record),
    attempt: attemptNumber,
    at: at.toISOString(),
    event: 'attempt/started',
    operation: record.operation,
    truncated: false,
    category: 'session',
    threadId: record.threadId,
    turnId: null,
    sessionId: record.sessionId,
    turnNumber: record.turnCount,
    processId: record.processId,
  })
}

export const recordCancellation = (record: AgentDetailRecord, at: Date, reason: string): void => {
  const summary = boundRedacted(reason).text
  endAttempt(record, at, 'cancelled', summary)
  setPhase(record, /stall/iu.test(reason) ? 'stalled' : 'cancelled', summary, at)
  push(record, {
    sequence: nextSequence(record),
    attempt: record.attempt,
    at: at.toISOString(),
    event: 'agent/cancelled',
    operation: record.operation,
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
): void => {
  const summary = observation.message === null ? null : boundRedacted(observation.message).text
  if (observation.remoteBranch !== undefined) {
    record.handoff.remoteBranch = { status: observation.status, name: observation.remoteBranch }
  }
  if (observation.pullRequest !== undefined) {
    record.handoff.pullRequest = { ...observation.pullRequest }
  }
  if (observation.outcome !== undefined) {
    record.handoff.outcome = observation.outcome
    // Only an outcome that actually ends the work closes the attempt. A missing branch or a failed
    // handoff is followed by another attempt, so closing it here would label a retrying attempt as
    // handed off — and the retry that follows could no longer correct it.
    if (handedOffOutcomes.has(observation.outcome)) {
      endAttempt(record, at, 'handed_off', summary)
    }
  }
  record.handoff.reason = summary
  setPhase(record, 'handing_off', summary ?? 'Handing off completed work', at)
  push(record, {
    sequence: nextSequence(record),
    attempt: record.attempt,
    at: at.toISOString(),
    event: `handoff/${observation.step}`,
    operation: record.operation,
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
  branch: string | null
  retry: Readonly<{ attempt: number; dueAt: Date; reason: string | null }> | null
}>

/** Builds the exact, immutable snapshot published to operator consumers. */
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
      attempts: frozen(record.attempts),
      sessions: frozen(record.sessions),
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
    usage: Object.freeze({ ...record.tokens }),
    rateLimits: frozen(record.rateLimits),
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
    handoff: Object.freeze({
      expectedBranch: record.handoff.expectedBranch,
      remoteBranch: Object.freeze({ ...record.handoff.remoteBranch }),
      pullRequest: Object.freeze({ ...record.handoff.pullRequest }),
      dispatchLabels: Object.freeze({
        ...record.handoff.dispatchLabels,
        labels: Object.freeze([...record.handoff.dispatchLabels.labels]),
      }),
      outcome: record.handoff.outcome,
      reason: record.handoff.reason,
    }),
    retry:
      context.retry === null
        ? null
        : Object.freeze({
            attempt: context.retry.attempt,
            dueAt: context.retry.dueAt.toISOString(),
            reason: context.retry.reason === null ? null : boundRedacted(context.retry.reason).text,
          }),
    errors: frozen(record.errors),
    timeline: Object.freeze({
      // Timeline events are frozen as they are appended, so the array copy is enough here.
      events: Object.freeze([...record.events]),
      retained: record.events.length,
      dropped: record.dropped,
      limit: timelineEventLimit,
    }),
  })
}
