import { Data, type Effect } from 'effect'

import type { Issue, JsonObject, Workspace } from '../domain/domain.js'
import type { HostToolSession } from '../host-tools.js'
import type { AgentEvent } from '../telemetry.js'

/** Configuration understood by an agent runner for one launched session. */
export type AgentRunnerConfig = Readonly<{
  command: string
  approvalPolicy: string
  threadSandbox: string
  /** Verbatim pass-through for the runner's turn sandbox policy. */
  turnSandboxPolicy: JsonObject | null
  turnTimeoutMs: number
  readTimeoutMs: number
  stallTimeoutMs: number
}>

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

export type AgentLaunch = Readonly<{
  issue: Issue
  workspace: Workspace
  /** The configured workspace root; containment is re-verified against it at launch. */
  workspaceRoot: string
  config: AgentRunnerConfig
  prompt: string
  maxTurns: number
  secretEnvironmentNames: readonly string[]
  /** Immutable adapter/tool/context selection for this session. */
  hostTools?: HostToolSession
  refreshIssue: () => Effect.Effect<Issue | null, AgentError>
  isRoutable: (issue: Issue) => boolean
  onEvent: (event: AgentEvent) => void
}>

export type AgentResult = Readonly<{
  threadId: string
  turnId: string
  turnCount: number
}>

/** The adapter-neutral launch operation consumed by the orchestrator. */
export type AgentRunner = (launch: AgentLaunch) => Effect.Effect<AgentResult, AgentError>

export type AgentTurnOutcome = 'completed' | 'cancelled' | 'failed'

/** Adapter-supplied interpretation of native statuses carried by agent lifecycle events. */
export type AgentEventSemantics = Readonly<{
  turnOutcome: (status: string) => AgentTurnOutcome
}>

export type { AgentEvent } from '../telemetry.js'
