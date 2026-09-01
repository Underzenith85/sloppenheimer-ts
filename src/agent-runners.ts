import { Effect, Layer, Option } from 'effect'
import { FileSystem } from '@effect/platform'

import { codexAgentRunner, codexAgentRunnerProvider } from '@sloppenheimer/adapter-codex'
import {
  makeAgentRunnerRegistry,
  type AgentRunnerRegistry,
  type RegisteredAgentRunner,
  type ValidatedAgentRunner,
} from '@sloppenheimer/core/domain/agent-runner-provider.js'
import { WorkflowError } from '@sloppenheimer/core/domain/errors.js'
import { AgentRunner, type AgentRunnerPort } from '@sloppenheimer/core/ports/agent-runner.js'

/**
 * The registered runner, with the factory that builds it. The factory is an ordinary effect with
 * its own requirements, so an adapter that needs the host filesystem says so here rather than
 * having it bound for it.
 */
export type RegisteredAgentRunnerPorts = RegisteredAgentRunner<
  Effect.Effect<AgentRunnerPort, never, FileSystem.FileSystem>
>

/**
 * The agent-runner kinds this build supports.
 *
 * This is the composition root's list, and the only place a runner kind is named: an adapter owns
 * its own settings validation, its authentication environment names, its default command, and its
 * session, so adding a second backend is one entry here and no change under `config/` or `core/`.
 */
const registered: readonly RegisteredAgentRunnerPorts[] = [
  { ...codexAgentRunnerProvider, runner: codexAgentRunner },
]

export const agentRunners: AgentRunnerRegistry<RegisteredAgentRunnerPorts> =
  makeAgentRunnerRegistry(registered)

/**
 * The kind a workflow that declares no runner is read as.
 *
 * Codex was the only backend when the runner section did not exist, so every workflow written
 * before it means Codex. Changing this default would silently repoint those workflows at a
 * different agent, which is a migration rather than a default.
 */
export const defaultAgentRunnerKind = codexAgentRunnerProvider.kind

const missingRunner = (selection: ValidatedAgentRunner): WorkflowError =>
  new WorkflowError({
    category: 'invalid_config',
    message: `runner.kind ${selection.kind} is registered but supplies no agent runner`,
  })

/**
 * Provides {@link AgentRunner} from the selection the workflow made.
 *
 * The runner is chosen once, at startup, from the workflow as it stands. It holds no per-workflow
 * state — everything that varies reaches it on the launch — so unlike the tracker it needs no cell
 * to be replaced through, and a reload that changes `runner.kind` is refused by the reload path
 * rather than quietly ignored here.
 */
export const layerAgentRunnerFor = (
  selection: ValidatedAgentRunner,
): Layer.Layer<AgentRunner, WorkflowError, FileSystem.FileSystem> =>
  Layer.effect(
    AgentRunner,
    Option.match(
      Option.flatMap(agentRunners.get(selection.kind), (entry) =>
        Option.fromNullable(entry.runner),
      ),
      {
        onNone: () => Effect.fail(missingRunner(selection)),
        onSome: (runner) => runner,
      },
    ),
  )
