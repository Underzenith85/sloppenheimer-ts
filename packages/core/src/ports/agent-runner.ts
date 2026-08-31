import { Context, Layer, type Effect } from 'effect'

import type { Issue, Workspace } from '../domain/domain.js'
import type { AgentError } from '../domain/errors.js'
import type { HostToolSession } from '../domain/host-tools.js'
import type { AgentEvent, AgentTurnOutcome } from '../telemetry.js'

/**
 * Session configuration for the agent runner.
 *
 * The four named fields are the ones the core genuinely consumes: `command` for preflight,
 * `stallTimeoutMs` for stall detection, and the two bounds every subprocess transport needs.
 * Everything else a backend takes — approval policy and sandbox for one, model and permission mode
 * for another — is that backend's business, so it travels as `settings` and is read back by the
 * adapter that validated it. A second runner therefore adds no field here.
 */
export type AgentRunnerConfig = Readonly<{
  command: string
  turnTimeoutMs: number
  readTimeoutMs: number
  stallTimeoutMs: number
  /**
   * The adapter-validated settings for the selected runner, opaque to everything above the
   * adapter. Read it back with `agentRunnerSettingsOf`; never inspect a field of it here.
   */
  settings: unknown
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

/**
 * Re-exported from the telemetry vocabulary, where it is declared beside {@link AgentLifecycle}
 * that carries it. A runner states the outcome on the settling event rather than being asked for it
 * afterwards.
 */
export type { AgentTurnOutcome }

/**
 * Runs one agent session to completion. Unlike the tracker and the workspace manager, the runner
 * holds no per-workflow state: everything that varies arrives in the launch, so a single instance
 * serves the whole run and no cell is needed.
 *
 * `run` is the whole of the behaviour. It used to carry an `AgentEventSemantics` beside it so the
 * runtime could ask a runner how to read its own turn statuses; each event now states its own
 * lifecycle meaning ({@link AgentLifecycle}), which is both less to implement and impossible to
 * consult for the wrong runner.
 */
export type AgentRunnerPort = Readonly<{
  /**
   * The kind this runner was selected as. Because there is no cell to replace the runner through,
   * a reload that names a different kind has to be refused rather than silently ignored, and this
   * is what the reload compares the reloaded workflow against — the runner actually bound, not a
   * previous workflow that may itself be stale.
   */
  kind: string
  run: (launch: AgentLaunch) => Effect.Effect<AgentResult, AgentError>
}>

export class AgentRunner extends Context.Tag('symphony/AgentRunner')<
  AgentRunner,
  AgentRunnerPort
>() {}

export const layerAgentRunner = (runner: AgentRunnerPort): Layer.Layer<AgentRunner> =>
  Layer.succeed(AgentRunner, runner)
