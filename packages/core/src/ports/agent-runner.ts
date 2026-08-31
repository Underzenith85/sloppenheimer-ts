import { Context, Layer, type Effect } from 'effect'

import type { Issue, JsonObject, Workspace } from '../domain/domain.js'
import type { AgentError } from '../domain/errors.js'
import type { HostToolSession } from '../domain/host-tools.js'
import type { AgentEvent } from '../telemetry.js'

/**
 * Session configuration for the agent runner, declared structurally rather than as an alias to a
 * concrete runner's config, so a port consumer never depends on one adapter's settings type. The
 * Codex config satisfies it today; a second runner widens the shape here rather than at every
 * launch site.
 */
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

/** Everything one agent session needs, captured before the session is launched. */
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

export type AgentTurnOutcome = 'completed' | 'cancelled' | 'failed'

/**
 * Adapter-supplied reading of the native turn statuses carried by lifecycle events. The runtime
 * reacts to the outcome, so normalizing a runner's own status vocabulary stays with that runner.
 */
export type AgentEventSemantics = Readonly<{
  turnOutcome: (status: string) => AgentTurnOutcome
}>

/**
 * Runs one agent session to completion. Unlike the tracker and the workspace manager, the runner
 * holds no per-workflow state: everything that varies arrives in the launch, so a single instance
 * serves the whole run and no cell is needed.
 */
export type AgentRunnerPort = Readonly<{
  run: (launch: AgentLaunch) => Effect.Effect<AgentResult, AgentError>
  /**
   * This runner's own reading of its turn statuses. It travels with `run` so a non-Codex runner is
   * never interpreted through another runner's status vocabulary.
   */
  semantics: AgentEventSemantics
}>

export class AgentRunner extends Context.Tag('symphony/AgentRunner')<
  AgentRunner,
  AgentRunnerPort
>() {}

export const layerAgentRunner = (runner: AgentRunnerPort): Layer.Layer<AgentRunner> =>
  Layer.succeed(AgentRunner, runner)
