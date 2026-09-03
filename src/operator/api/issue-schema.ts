// The runtime half of the per-issue resource in `issue.ts`, on the same terms as `state-schema.ts`:
// the schema is annotated with the published type, so the two cannot drift apart without the build
// saying so, and nothing is sent that has not been encoded through it.

import { Schema } from 'effect'

import { timelineCategories } from '@sloppenheimer/core/telemetry.js'

import type {
  PublishedIssueDetail,
  PublishedIssueError,
  PublishedIssueEvent,
  PublishedIssueRetry,
  PublishedIssueRun,
} from './issue.js'
import { publishedTokensSchema } from './tokens.js'

const publishedIssueRunSchema: Schema.Schema<PublishedIssueRun> = Schema.Struct({
  started_at: Schema.String,
  last_activity_at: Schema.NullOr(Schema.String),
  elapsed_ms: Schema.Number,
  idle_ms: Schema.NullOr(Schema.Number),
  phase: Schema.NullOr(Schema.String),
  operation: Schema.NullOr(Schema.String),
  thread_id: Schema.NullOr(Schema.String),
  turn_id: Schema.NullOr(Schema.String),
  session_id: Schema.NullOr(Schema.String),
  process_id: Schema.NullOr(Schema.Number),
  turn_number: Schema.Number,
  worker_host: Schema.String,
  stall_deadline: Schema.NullOr(Schema.String),
  stalled: Schema.Boolean,
  tokens: publishedTokensSchema,
})

const publishedIssueRetrySchema: Schema.Schema<PublishedIssueRetry> = Schema.Struct({
  attempt: Schema.Number,
  due_at: Schema.String,
  reason: Schema.NullOr(Schema.String),
})

/**
 * The categories are taken from the runtime's own list rather than restated, because that list is
 * what the timeline is built against: a category added there is published here without anybody
 * remembering to widen a second vocabulary.
 */
const publishedIssueEventSchema: Schema.Schema<PublishedIssueEvent> = Schema.Struct({
  sequence: Schema.Number,
  at: Schema.String,
  attempt: Schema.Number,
  category: Schema.Literal(...timelineCategories),
  event: Schema.String,
  operation: Schema.NullOr(Schema.String),
})

const publishedIssueErrorSchema: Schema.Schema<PublishedIssueError> = Schema.Struct({
  at: Schema.String,
  attempt: Schema.Number,
  severity: Schema.Literal('warning', 'error'),
  code: Schema.NullOr(Schema.String),
  message: Schema.String,
})

export const publishedIssueDetailSchema: Schema.Schema<PublishedIssueDetail> = Schema.Struct({
  self: Schema.String,
  issue_id: Schema.NullOr(Schema.String),
  issue_identifier: Schema.String,
  issue_url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  status: Schema.Literal('starting', 'running', 'retrying', 'handoff', 'completed', 'idle'),
  tracked: Schema.Boolean,
  workspace: Schema.Struct({ path: Schema.NullOr(Schema.String) }),
  attempts: Schema.Struct({
    restart_count: Schema.Number,
    current_retry_attempt: Schema.Number,
  }),
  running: Schema.NullOr(publishedIssueRunSchema),
  retry: Schema.NullOr(publishedIssueRetrySchema),
  logs: Schema.Struct({
    retained: Schema.Number,
    dropped: Schema.Number,
    limit: Schema.Number,
    published: Schema.Number,
  }),
  recent_events: Schema.Array(publishedIssueEventSchema),
  last_error: Schema.NullOr(publishedIssueErrorSchema),
  detail_url: Schema.String,
})
