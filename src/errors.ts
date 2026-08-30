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
    | 'tracker_response'
    | 'tracker_pagination'
    | 'tracker_rate_limited'
  readonly message: string
  readonly retryable: boolean
  /** Adapter-supplied delay before the request may be retried, when the tracker advertises one. */
  readonly retryAfterMs?: number
  readonly cause?: unknown
}> {}

export class WorkspaceError extends Data.TaggedError('WorkspaceError')<{
  readonly category:
    | 'invalid_path'
    | 'create_failed'
    | 'hook_failed'
    | 'hook_timeout'
    | 'inspect_failed'
    | 'remove_failed'
  readonly message: string
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
