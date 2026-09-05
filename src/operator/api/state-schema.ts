// The runtime half of the contract in `state.ts`. Every document that module maps is encoded
// through these schemas before it leaves the host, so a mapping that stopped agreeing with its own
// type is a failed response rather than a silently reshaped one. Each schema is annotated with the
// type it serves, which makes the two statements one: a renamed field, a changed nullability or a
// dropped row breaks the build here rather than the reader downstream.
//
// Wire numbers are `Schema.Number` rather than bounded integers. A count reaches this boundary from
// a coding agent's own report, and a value the API already forwards must not begin failing the
// response that carries it.

import { Schema } from 'effect'

import type { JsonObject, JsonValue } from '@sloppenheimer/core/support/json.js'

import type {
  PublishedCompleted,
  PublishedDelivering,
  PublishedHandoff,
  PublishedRefresh,
  PublishedRetainedWorkspaces,
  PublishedRetrying,
  PublishedRunning,
  PublishedState,
} from './state.js'
import { publishedTokensSchema, publishedTotalsSchema } from './tokens.js'

/**
 * The coding agent's rate-limit report, passed through as it arrived. Its keys belong to that
 * protocol rather than to this API, so the schema states only that the report is JSON.
 */
const jsonValueSchema: Schema.Schema<JsonValue> = Schema.Union(
  Schema.Null,
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.suspend((): Schema.Schema<JsonValue> => jsonValueSchema)),
  Schema.Record({
    key: Schema.String,
    value: Schema.suspend((): Schema.Schema<JsonValue> => jsonValueSchema),
  }),
).annotations({ identifier: 'JsonValue' })

const jsonObjectSchema: Schema.Schema<JsonObject> = Schema.Record({
  key: Schema.String,
  value: jsonValueSchema,
}).annotations({ identifier: 'JsonObject' })

const publishedRunningSchema: Schema.Schema<PublishedRunning> = Schema.Struct({
  issue_id: Schema.String,
  issue_identifier: Schema.String,
  issue_url: Schema.NullOr(Schema.String),
  title: Schema.String,
  state: Schema.String,
  attempt: Schema.NullOr(Schema.Number),
  started_at: Schema.String,
  last_event_at: Schema.NullOr(Schema.String),
  last_event: Schema.NullOr(Schema.String),
  last_message: Schema.NullOr(Schema.String),
  process_id: Schema.NullOr(Schema.Number),
  thread_id: Schema.NullOr(Schema.String),
  turn_id: Schema.NullOr(Schema.String),
  session_id: Schema.NullOr(Schema.String),
  turn_count: Schema.Number,
  tokens: publishedTokensSchema,
  last_reported_tokens: publishedTokensSchema,
  worker_host: Schema.Literal('local'),
  stall_deadline: Schema.NullOr(Schema.String),
  detail_url: Schema.String,
})

const publishedRetryingSchema: Schema.Schema<PublishedRetrying> = Schema.Struct({
  issue_id: Schema.String,
  issue_identifier: Schema.String,
  issue_url: Schema.NullOr(Schema.String),
  title: Schema.String,
  attempt: Schema.Number,
  due_at: Schema.String,
  error: Schema.NullOr(Schema.String),
  worker_host: Schema.Literal('local'),
  detail_url: Schema.String,
})

const publishedDeliveringSchema: Schema.Schema<PublishedDelivering> = Schema.Struct({
  issue_id: Schema.String,
  issue_identifier: Schema.String,
  issue_url: Schema.NullOr(Schema.String),
  title: Schema.String,
  branch_name: Schema.String,
  attempt: Schema.Number,
  due_at: Schema.String,
  category: Schema.String,
  reason: Schema.String,
  intervention_required: Schema.optionalWith(Schema.Boolean, { exact: true }),
  changed_file_count: Schema.NullOr(Schema.Number),
  repair_run: Schema.Boolean,
  observed_at: Schema.String,
  worker_host: Schema.Literal('local'),
  detail_url: Schema.String,
})

const publishedRetainedWorkspacesSchema: Schema.Schema<PublishedRetainedWorkspaces> = Schema.Struct(
  {
    issue_id: Schema.String,
    issue_identifier: Schema.String,
    count: Schema.Number,
    bytes: Schema.Number,
    observed_at: Schema.String,
  },
)

const publishedCompletedSchema: Schema.Schema<PublishedCompleted> = Schema.Struct({
  issue_id: Schema.String,
  issue_identifier: Schema.String,
  issue_url: Schema.NullOr(Schema.String),
  title: Schema.String,
  outcome: Schema.Literal('merged'),
  finished_at: Schema.String,
  pull_request_url: Schema.NullOr(Schema.String),
})

/**
 * The handoff lifecycle states, spelled out rather than borrowed as a string. The wire is where
 * this vocabulary becomes a promise to a reader, so a state the runtime adds is a deliberate
 * addition here too — and the annotation above makes forgetting one a build failure.
 */
const publishedHandoffSchema: Schema.Schema<PublishedHandoff> = Schema.Struct({
  issue_id: Schema.String,
  issue_identifier: Schema.String,
  pull_request_url: Schema.String,
  branch_name: Schema.String,
  state: Schema.Literal(
    'merged',
    'closed_without_merge',
    'awaiting_checks',
    'repair_needed',
    'rebase_needed',
    'ready_to_merge',
    'merging',
    'intervention_required',
    'delivery_failed',
  ),
  head_sha: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  repair_attempts: Schema.Number,
  observed_at: Schema.String,
})

export const publishedStateSchema: Schema.Schema<PublishedState> = Schema.Struct({
  durable_workflows: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        issue_id: Schema.String,
        issue_identifier: Schema.String,
        title: Schema.String,
        status: Schema.String,
        intent: Schema.String,
        reason: Schema.NullOr(Schema.String),
        workspace_path: Schema.NullOr(Schema.String),
        candidate_head: Schema.NullOr(Schema.String),
        published_head: Schema.NullOr(Schema.String),
      }),
    ),
    { exact: true },
  ),
  generated_at: Schema.String,
  workflow_path: Schema.String,
  effective_workflow: Schema.Struct({
    fingerprint: Schema.String,
    loaded_at: Schema.String,
  }),
  workflow_reload_error: Schema.NullOr(
    Schema.Struct({ message: Schema.String, observed_at: Schema.String }),
  ),
  handoff_recovery: Schema.Struct({
    status: Schema.Literal('recovering', 'completed', 'degraded'),
    loaded: Schema.Number,
    recovered: Schema.Number,
    skipped: Schema.Number,
    failed: Schema.Number,
    store_error: Schema.NullOr(
      Schema.Struct({
        operation: Schema.Literal('read', 'write'),
        message: Schema.String,
        observed_at: Schema.String,
      }),
    ),
  }),
  polling_interval_ms: Schema.Number,
  max_concurrent_agents: Schema.Number,
  retained_workspace_limit: Schema.Number,
  counts: Schema.Struct({
    running: Schema.Number,
    retrying: Schema.Number,
    delivering: Schema.Number,
    completed: Schema.Number,
  }),
  paused_issue_numbers: Schema.Array(Schema.Number),
  handoffs: Schema.Array(publishedHandoffSchema),
  running: Schema.Array(publishedRunningSchema),
  retrying: Schema.Array(publishedRetryingSchema),
  delivering: Schema.Array(publishedDeliveringSchema),
  completed: Schema.Array(publishedCompletedSchema),
  retained_workspaces: Schema.Array(publishedRetainedWorkspacesSchema),
  saturated_states: Schema.Array(Schema.String),
  inspectable_agents: Schema.Array(Schema.String),
  codex_totals: publishedTotalsSchema,
  rate_limits: Schema.NullOr(jsonObjectSchema),
})

export const publishedRefreshSchema: Schema.Schema<PublishedRefresh> = Schema.Struct({
  queued: Schema.Boolean,
  coalesced: Schema.Boolean,
  requested_at: Schema.String,
  operations: Schema.Array(Schema.String),
})
