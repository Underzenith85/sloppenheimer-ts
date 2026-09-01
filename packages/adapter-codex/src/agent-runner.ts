/**
 * Codex as an implementation of the agent-runner port.
 *
 * `codex.ts` holds the App Server client and the session it drives; this module is the seam that
 * presents it as an {@link AgentRunnerPort} and hands the composition root a layer to provide.
 * Everything Codex-specific about the contract lives here, so nothing above the adapter names a
 * backend: the runner arrives through {@link AgentRunner}, and each event Codex emits states its
 * own lifecycle meaning, so the runtime never reads a status string this backend chose.
 */

import { FileSystem } from '@effect/platform'
import { Effect, Layer } from 'effect'

import { AgentRunner, type AgentRunnerPort } from '@sloppenheimer/core/ports/agent-runner.js'
import { runAgent } from './codex.js'
import { codexAgentRunnerProvider } from './settings.js'

/**
 * The Codex agent runner, satisfying the port with the App Server session as its one operation.
 *
 * Launch verification reads the workspace through `FileSystem`, so the runner is built against the
 * filesystem the composition root bound rather than reaching for `node:fs` itself. Binding it once
 * here keeps the port's own signature free of the requirement.
 */
export const codexAgentRunner: Effect.Effect<AgentRunnerPort, never, FileSystem.FileSystem> =
  Effect.map(FileSystem.FileSystem, (fileSystem) => ({
    kind: codexAgentRunnerProvider.kind,
    run: (launch) =>
      runAgent(launch).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
  }))

/** Provides {@link AgentRunner} from this adapter, for a composition root that selects Codex. */
export const layerCodexAgentRunner: Layer.Layer<AgentRunner, never, FileSystem.FileSystem> =
  Layer.effect(AgentRunner, codexAgentRunner)
