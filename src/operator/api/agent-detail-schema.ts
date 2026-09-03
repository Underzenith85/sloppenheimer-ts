// The runtime half of the agent detail resource. The document is the runtime's own published read
// model rather than a mapping of it, so the type comes from `@sloppenheimer/core/telemetry.js` and
// this module states the shape the API promises for it.
//
// Every schema here is annotated with the published type it serves, so the timeline vocabulary and
// the handoff lifecycle cannot grow a case in the runtime without this contract being widened to
// match — the build says so before a reader is handed a document the schema would refuse.

import { Schema } from 'effect'

import type {
  AgentAttemptSummary,
  AgentDetailSnapshot,
  AgentErrorSummary,
  AgentHandoffDetail,
  AgentPublicationDetail,
  AgentSessionSummary,
  AgentTimelineEvent,
  AgentWorkspaceSummary,
  FileChange,
  RateLimitWindow,
  TokenCounts,
} from '@sloppenheimer/core/telemetry.js'

const toolState = Schema.Literal('started', 'completed', 'failed', 'approved', 'withheld')
const qualityPhase = Schema.Literal('format', 'lint', 'typecheck', 'test', 'build', 'check')
const handoffStepStatus = Schema.Literal('pending', 'observed', 'absent', 'failed', 'not_performed')

const tokenCountsSchema: Schema.Schema<TokenCounts> = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  totalTokens: Schema.Number,
})

const rateLimitWindowSchema: Schema.Schema<RateLimitWindow> = Schema.Struct({
  name: Schema.String,
  usedPercent: Schema.NullOr(Schema.Number),
  windowMinutes: Schema.NullOr(Schema.Number),
  resetsInSeconds: Schema.NullOr(Schema.Number),
})

const fileChangeSchema: Schema.Schema<FileChange> = Schema.Struct({
  path: Schema.String,
  change: Schema.Literal('add', 'update', 'delete', 'unknown'),
  addedLines: Schema.NullOr(Schema.Number),
  deletedLines: Schema.NullOr(Schema.Number),
})

/** The fields every timeline entry carries, spread over each category's own. */
const timelineBaseFields = {
  sequence: Schema.Number,
  attempt: Schema.Number,
  at: Schema.String,
  event: Schema.String,
  operation: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
}

const timelineEventSchema: Schema.Schema<AgentTimelineEvent> = Schema.Union(
  Schema.Struct({
    ...timelineBaseFields,
    category: Schema.Literal('session'),
    threadId: Schema.NullOr(Schema.String),
    turnId: Schema.NullOr(Schema.String),
    sessionId: Schema.NullOr(Schema.String),
    turnNumber: Schema.Number,
    processId: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({ ...timelineBaseFields, category: Schema.Literal('reasoning') }),
  Schema.Struct({
    ...timelineBaseFields,
    category: Schema.Literal('message'),
    role: Schema.Literal('assistant', 'user'),
    text: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...timelineBaseFields,
    category: Schema.Literal('tool'),
    name: Schema.String,
    state: toolState,
    inputBytes: Schema.NullOr(Schema.Number),
    outputBytes: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    ...timelineBaseFields,
    category: Schema.Literal('file'),
    state: toolState,
    files: Schema.Array(fileChangeSchema),
    fileCount: Schema.Number,
    addedLines: Schema.NullOr(Schema.Number),
    deletedLines: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    ...timelineBaseFields,
    category: Schema.Literal('command'),
    program: Schema.String,
    argumentCount: Schema.Number,
    quality: Schema.NullOr(qualityPhase),
    state: toolState,
    exitCode: Schema.NullOr(Schema.Number),
    durationMs: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    ...timelineBaseFields,
    category: Schema.Literal('usage'),
    tokens: Schema.NullOr(tokenCountsSchema),
    rateLimits: Schema.Array(rateLimitWindowSchema),
  }),
  Schema.Struct({
    ...timelineBaseFields,
    category: Schema.Literal('retry'),
    attemptNumber: Schema.Number,
    dueAt: Schema.NullOr(Schema.String),
    reason: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...timelineBaseFields,
    category: Schema.Literal('error'),
    severity: Schema.Literal('warning', 'error'),
    code: Schema.NullOr(Schema.String),
    message: Schema.String,
  }),
  Schema.Struct({
    ...timelineBaseFields,
    category: Schema.Literal('cancellation'),
    reason: Schema.String,
  }),
  Schema.Struct({
    ...timelineBaseFields,
    category: Schema.Literal('handoff'),
    step: Schema.Literal(
      'local_branch',
      'publication',
      'remote_branch',
      'pull_request',
      'dispatch_label',
      'outcome',
    ),
    status: handoffStepStatus,
    message: Schema.NullOr(Schema.String),
  }),
)

const sessionSummarySchema: Schema.Schema<AgentSessionSummary> = Schema.Struct({
  attempt: Schema.Number,
  threadId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  processId: Schema.NullOr(Schema.Number),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
})

const attemptSummarySchema: Schema.Schema<AgentAttemptSummary> = Schema.Struct({
  attempt: Schema.Number,
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  outcome: Schema.Literal('running', 'retrying', 'cancelled', 'handed_off', 'ended'),
  reason: Schema.NullOr(Schema.String),
  firstSequence: Schema.Number,
  lastSequence: Schema.Number,
})

const errorSummarySchema: Schema.Schema<AgentErrorSummary> = Schema.Struct({
  at: Schema.String,
  attempt: Schema.Number,
  severity: Schema.Literal('warning', 'error'),
  code: Schema.NullOr(Schema.String),
  message: Schema.String,
})

const workspaceSummarySchema: Schema.Schema<AgentWorkspaceSummary> = Schema.Struct({
  pathKey: Schema.String,
  branch: Schema.NullOr(Schema.String),
  dirtyFileCount: Schema.Number,
  addedLines: Schema.Number,
  deletedLines: Schema.Number,
  lastFileActivityAt: Schema.NullOr(Schema.String),
  qualityPhase: Schema.NullOr(qualityPhase),
  qualityCommandState: Schema.NullOr(toolState),
  pathsTruncated: Schema.Boolean,
})

const publicationDetailSchema: Schema.Schema<AgentPublicationDetail> = Schema.Struct({
  status: Schema.Literal('not_performed', 'pending', 'published', 'no_changes', 'failed'),
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  baselineSha: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  attempts: Schema.Number,
  reason: Schema.NullOr(Schema.String),
})

const handoffDetailSchema: Schema.Schema<AgentHandoffDetail> = Schema.Struct({
  expectedBranch: Schema.NullOr(Schema.String),
  publication: publicationDetailSchema,
  remoteBranch: Schema.Struct({
    status: handoffStepStatus,
    name: Schema.NullOr(Schema.String),
  }),
  pullRequest: Schema.Struct({
    status: Schema.Literal('pending', 'created', 'reused', 'absent'),
    number: Schema.NullOr(Schema.Number),
    url: Schema.NullOr(Schema.String),
    state: Schema.NullOr(Schema.String),
  }),
  dispatchLabels: Schema.Struct({
    labels: Schema.Array(Schema.String),
    status: handoffStepStatus,
    reason: Schema.NullOr(Schema.String),
  }),
  outcome: Schema.Literal(
    'in_progress',
    'no_progress',
    'no_branch',
    'delivery_failed',
    'pull_request_open',
    'merged',
    'intervention_required',
    'failed',
  ),
  reason: Schema.NullOr(Schema.String),
})

export const agentDetailSchema: Schema.Schema<AgentDetailSnapshot> = Schema.Struct({
  version: Schema.Literal('v1'),
  self: Schema.String,
  generatedAt: Schema.String,
  issueId: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  status: Schema.Literal('running', 'retrying', 'completed'),
  handoffEnabled: Schema.Boolean,
  identity: Schema.Struct({
    threadId: Schema.NullOr(Schema.String),
    turnId: Schema.NullOr(Schema.String),
    sessionId: Schema.NullOr(Schema.String),
    processId: Schema.NullOr(Schema.Number),
    turnNumber: Schema.Number,
    workerHost: Schema.String,
  }),
  attempt: Schema.Struct({
    current: Schema.Number,
    retries: Schema.Number,
    attempts: Schema.Array(attemptSummarySchema),
    sessions: Schema.Array(sessionSummarySchema),
  }),
  phase: Schema.Struct({
    phase: Schema.Literal(
      'starting',
      'reasoning',
      'responding',
      'running_tool',
      'running_command',
      'editing',
      'awaiting_model',
      'retrying',
      'publishing',
      'handing_off',
      'cancelled',
      'stalled',
    ),
    operation: Schema.NullOr(Schema.String),
    since: Schema.String,
  }),
  activity: Schema.Struct({
    startedAt: Schema.String,
    lastActivityAt: Schema.NullOr(Schema.String),
    elapsedMs: Schema.Number,
    idleMs: Schema.Number,
    stallTimeoutMs: Schema.Number,
    stallDeadline: Schema.NullOr(Schema.String),
    stallCountdownMs: Schema.NullOr(Schema.Number),
    stalled: Schema.Boolean,
  }),
  usage: tokenCountsSchema,
  rateLimits: Schema.Array(rateLimitWindowSchema),
  workspace: workspaceSummarySchema,
  handoff: handoffDetailSchema,
  retry: Schema.NullOr(
    Schema.Struct({
      attempt: Schema.Number,
      dueAt: Schema.String,
      reason: Schema.NullOr(Schema.String),
    }),
  ),
  errors: Schema.Array(errorSummarySchema),
  timeline: Schema.Struct({
    events: Schema.Array(timelineEventSchema),
    retained: Schema.Number,
    dropped: Schema.Number,
    limit: Schema.Number,
  }),
})

/** What `GET /api/v1/agents/:identifier` answers with: the versioned envelope around the detail. */
export type PublishedAgentDetail = Readonly<{ version: 'v1'; detail: AgentDetailSnapshot }>

export const publishedAgentDetailSchema: Schema.Schema<PublishedAgentDetail> = Schema.Struct({
  version: Schema.Literal('v1'),
  detail: agentDetailSchema,
})
