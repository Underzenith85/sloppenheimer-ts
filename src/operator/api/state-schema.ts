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
  durable_workflows: Schema.Array(
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
      progress: Schema.Struct({
        stage: Schema.String,
        cleanup_state: Schema.NullOr(Schema.String),
        cleanup_reason: Schema.NullOr(Schema.String),
        cleanup_due_at: Schema.NullOr(Schema.Number),
        wait_reason: Schema.NullOr(Schema.String),
        operation_id: Schema.NullOr(Schema.String),
        operation_deadline: Schema.NullOr(Schema.Number),
        last_progress_at: Schema.Number,
        verified_revision: Schema.NullOr(Schema.String),
        coding_attempts: Schema.Number,
        maximum_coding_attempts: Schema.Number,
        repair_attempts: Schema.Number,
        maximum_repair_attempts: Schema.Number,
        transport_failures: Schema.Number,
        budget_deadline: Schema.Number,
        next_action: Schema.String,
      }),
    }),
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
  rate_limits: Schema.Array(
    Schema.Union(
      Schema.Struct({
        source: Schema.Literal('codex_agent'),
        scope: Schema.Literal('host'),
        observed_at: Schema.String,
        stale: Schema.Boolean,
        effect: Schema.Literal('informational', 'none'),
        windows: Schema.Array(
          Schema.Struct({
            source: Schema.Literal('agent_telemetry'),
            name: Schema.String,
            observedAt: Schema.String,
            resetAt: Schema.NullOr(Schema.String),
            stale: Schema.Boolean,
            effect: Schema.Literal('informational', 'none'),
            usedPercent: Schema.NullOr(Schema.Number),
            windowMinutes: Schema.NullOr(Schema.Number),
            resetsInSeconds: Schema.NullOr(Schema.Number),
          }),
        ),
      }),
      Schema.Struct({
        source: Schema.Literal('github_local_pacing'),
        scope: Schema.String,
        observed_at: Schema.String,
        queued_requests: Schema.Number,
        oldest_wait_ms: Schema.Number,
        maximum_expected_wait_ms: Schema.Number,
        effect: Schema.Literal('delaying', 'idle'),
      }),
      Schema.Struct({
        source: Schema.Literal('github_response'),
        scope: Schema.String,
        observed_at: Schema.String,
        status: Schema.Number,
        remaining: Schema.NullOr(Schema.Number),
        limit: Schema.NullOr(Schema.Number),
        reset_at: Schema.NullOr(Schema.String),
        stale: Schema.Boolean,
        effect: Schema.Literal('rejected', 'available'),
      }),
    ),
  ),
})

export const publishedRefreshSchema: Schema.Schema<PublishedRefresh> = Schema.Struct({
  queued: Schema.Boolean,
  coalesced: Schema.Boolean,
  requested_at: Schema.String,
  operations: Schema.Array(Schema.String),
})
