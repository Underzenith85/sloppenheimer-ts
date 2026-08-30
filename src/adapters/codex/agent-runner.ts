/**
 * Codex as an implementation of the agent-runner port.
 *
 * `codex.ts` holds the App Server client and the session it drives; this module is the seam that
 * presents it as an {@link AgentRunnerPort} and hands the composition root a layer to provide.
 * Everything Codex-specific about the contract lives here, so nothing above the adapter names a
 * backend: the runner arrives through {@link AgentRunner}, and the runtime reads turn outcomes
 * through {@link AgentEventSemantics} rather than matching Codex's own status strings.
 */

import type { Layer } from 'effect'

import {
  layerAgentRunner,
  type AgentEventSemantics,
  type AgentRunner,
  type AgentRunnerPort,
} from '../../ports/agent-runner.js'
import { isCancelledTurnStatus, runAgent } from './codex.js'

/** The Codex agent runner, satisfying the port with the App Server session as its one operation. */
export const codexAgentRunner: AgentRunnerPort = { run: runAgent }

/**
 * Codex's own turn-status vocabulary, kept with the adapter so the core runtime reacts to an
 * outcome rather than matching one runner's status strings.
 */
export const codexAgentEventSemantics: AgentEventSemantics = {
  turnOutcome: (status) =>
    status === 'completed' ? 'completed' : isCancelledTurnStatus(status) ? 'cancelled' : 'failed',
}

/** Provides {@link AgentRunner} from this adapter, for a composition root that selects Codex. */
export const layerCodexAgentRunner: Layer.Layer<AgentRunner> = layerAgentRunner(codexAgentRunner)
