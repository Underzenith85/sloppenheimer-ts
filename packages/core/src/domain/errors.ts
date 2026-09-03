import { Data } from 'effect'

export class WorkflowError extends Data.TaggedError('WorkflowError')<{
  readonly category:
    | 'missing_workflow_file'
    | 'workflow_parse_error'
    | 'workflow_front_matter_not_a_map'
    | 'invalid_config'
    | 'template_parse_error'
    | 'template_render_error'
  readonly message: string
  readonly cause?: unknown
}> {}

export class TrackerError extends Data.TaggedError('TrackerError')<{
  readonly category:
    | 'unsupported_tracker_kind'
    | 'invalid_tracker_config'
    | 'missing_tracker_secret'
    | 'tracker_request'
    | 'tracker_status'
    /** The tracker says the record does not exist: never retryable, and not a transient status. */
    | 'tracker_not_found'
    | 'tracker_response'
    | 'tracker_pagination'
    | 'tracker_rate_limited'
  readonly message: string
  readonly retryable: boolean
  /** Adapter-supplied delay before the request may be retried, when the tracker advertises one. */
  readonly retryAfterMs?: number
  readonly cause?: unknown
}> {}

export class HandoffStoreError extends Data.TaggedError('HandoffStoreError')<{
  readonly operation: 'read' | 'write'
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Kept apart from `HandoffStoreError` because the two stores fail for different reasons and cost
 * different things: an unreadable handoff store risks abandoning a live pull request, while an
 * unreadable completion store loses only the history the console shows.
 */
export class CompletionStoreError extends Data.TaggedError('CompletionStoreError')<{
  readonly operation: 'read' | 'write'
  readonly message: string
  readonly cause?: unknown
}> {}

export class WorkspaceError extends Data.TaggedError('WorkspaceError')<{
  readonly category:
    | 'invalid_path'
    | 'create_failed'
    | 'hook_failed'
    | 'hook_timeout'
    | 'inspect_failed'
    | 'lease_conflict'
    | 'remove_failed'
  readonly message: string
  readonly cause?: unknown
}> {}

export class SourceControlError extends Data.TaggedError('SourceControlError')<{
  readonly category:
    | 'invalid_repository'
    | 'prepare_failed'
    | 'publication_failed'
    | 'rebase_conflict'
    | 'lease_conflict'
    | 'authentication_failed'
  readonly message: string
  readonly retryable: boolean
  /** Whether the local edits or commit remain available for another publication attempt. */
  readonly worktreePreserved: boolean
  readonly cause?: unknown
}> {}

export class AgentError extends Data.TaggedError('AgentError')<{
  readonly category:
    | 'spawn_failed'
    | 'workspace_rejected'
    | 'protocol_error'
    | 'read_timeout'
    | 'turn_timeout'
    | 'turn_failed'
    | 'turn_cancelled'
    | 'input_required'
    | 'process_exited'
  readonly message: string
  readonly cause?: unknown
}> {}

export class ServerError extends Data.TaggedError('ServerError')<{
  readonly category: 'listen_failed' | 'close_failed'
  readonly message: string
  readonly cause?: unknown
}> {}
