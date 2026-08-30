import { Context, Layer, type Effect } from 'effect'

import type { CodexConfig } from '../config/workflow.js'
import type { Issue, Workspace } from '../domain/domain.js'
import type { AgentError } from '../errors.js'
import type { HostToolSession } from '../host-tools.js'
import type { AgentEvent } from '../telemetry.js'

/**
 * Session configuration for the agent runner. Only one runner exists today, so the alias resolves
 * to the Codex session config; it exists so a second runner can widen the shape here rather than
 * at every launch site.
 */
export type AgentRunnerConfig = CodexConfig

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

/**
 * Runs one agent session to completion. Unlike the tracker and the workspace manager, the runner
 * holds no per-workflow state: everything that varies arrives in the launch, so a single instance
 * serves the whole run and no cell is needed.
 */
export type AgentRunnerPort = Readonly<{
  run: (launch: AgentLaunch) => Effect.Effect<AgentResult, AgentError>
}>

export class AgentRunner extends Context.Tag('symphony/AgentRunner')<
  AgentRunner,
  AgentRunnerPort
>() {}

export const layerAgentRunner = (runner: AgentRunnerPort): Layer.Layer<AgentRunner> =>
  Layer.succeed(AgentRunner, runner)
