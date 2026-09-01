/**
 * The published read model: the timeline, the summaries, and the snapshot an operator consumer
 * receives.
 *
 * These are the types the HTTP API and the console are written against, so they are ordinary
 * JSON-shaped values — every instant is an ISO string and every absence is `null`. The retention
 * limits live here too, because a bounded collection is part of what the snapshot promises rather
 * than an implementation detail of the recorder that enforces it.
 */

import type {
  ErrorSeverity,
  FileChange,
  MessageRole,
  QualityPhase,
  RateLimitWindow,
  TokenCounts,
  ToolState,
} from './events.js'

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

/**
 * The fields every timeline entry carries, whichever category it is. A recorder builds these once
 * and the category's own fields are spread over them.
 */
export type AgentTimelineBase = Readonly<{
  sequence: number
  attempt: number
  at: string
  event: string
  operation: string | null
  truncated: boolean
}>

export type AgentTimelineEvent =
  | (AgentTimelineBase &
      Readonly<{
        category: 'session'
        threadId: string | null
        turnId: string | null
        sessionId: string | null
        turnNumber: number
        processId: number | null
      }>)
  | (AgentTimelineBase & Readonly<{ category: 'reasoning' }>)
  | (AgentTimelineBase & Readonly<{ category: 'message'; role: MessageRole; text: string | null }>)
  | (AgentTimelineBase &
      Readonly<{
        category: 'tool'
        name: string
        state: ToolState
        inputBytes: number | null
        outputBytes: number | null
      }>)
  | (AgentTimelineBase &
      Readonly<{
        category: 'file'
        state: ToolState
        files: readonly FileChange[]
      }>)
  | (AgentTimelineBase &
      Readonly<{
        category: 'command'
        program: string
        argumentCount: number
        quality: QualityPhase | null
        state: ToolState
        exitCode: number | null
        durationMs: number | null
      }>)
  | (AgentTimelineBase &
      Readonly<{
        category: 'usage'
        tokens: TokenCounts | null
        rateLimits: readonly RateLimitWindow[]
      }>)
  | (AgentTimelineBase &
      Readonly<{
        category: 'retry'
        attemptNumber: number
        dueAt: string | null
        reason: string | null
      }>)
  | (AgentTimelineBase &
      Readonly<{
        category: 'error'
        severity: ErrorSeverity
        code: string | null
        message: string
      }>)
  | (AgentTimelineBase & Readonly<{ category: 'cancellation'; reason: string }>)
  | (AgentTimelineBase &
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
