import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'

import { codexAgentRunner, layerCodexAgentRunner } from '@symphony/adapter-codex/agent-runner.js'
import { issueId, issueIdentifier, type Issue } from '@symphony/core/domain/domain.js'
import { codexTurnOutcome, type AgentLaunch } from '@symphony/adapter-codex/codex.js'
import { AgentRunner, type AgentRunnerPort } from '@symphony/core/ports/agent-runner.js'
import { hostFileSystem } from '../../harness/filesystem.js'
import { codexRunnerConfig } from '../../harness/codex-runner-config.js'
import { anIssue } from '../../harness/fixtures.js'

const codexConfig = codexRunnerConfig({
  command: 'codex app-server',
  turnTimeoutMs: 1_000,
  readTimeoutMs: 1_000,
  stallTimeoutMs: 1_000,
})

const issue: Issue = anIssue({
  id: issueId('19'),
  identifier: issueIdentifier('example/symphony#19'),
  title: 'Bind the runner to a filesystem',
  labels: [],
})

/** A launch whose workspace is not contained by its root, which launch verification refuses first. */
const uncontainedLaunch: AgentLaunch = {
  issue,
  workspace: { path: '/etc', key: 'etc', createdNow: false },
  workspaceRoot: '/tmp/symphony-agent-runner-root',
  config: codexConfig,
  prompt: 'work',
  maxTurns: 1,
  secretEnvironmentNames: [],
  refreshIssue: () => Effect.succeed(null),
  isRoutable: () => false,
  onEvent: () => undefined,
}

const buildRunner = (): Effect.Effect<AgentRunnerPort> =>
  codexAgentRunner.pipe(Effect.provide(hostFileSystem))

describe('Codex agent runner adapter', (): void => {
  /*
   * The runner binds the filesystem that launch verification reads through, so the port's own
   * signature carries no such requirement. What `run` does before anything else is that
   * verification, which is what this asserts it still reaches.
   */
  it.effect('satisfies the port with the App Server session', () =>
    Effect.gen(function* () {
      const runner = yield* buildRunner()

      const error = yield* Effect.flip(runner.run(uncontainedLaunch))

      expect(error.category).toBe('workspace_rejected')
      expect(runner.kind).toBe('codex')
    }),
  )

  it.effect('provides the agent runner tag from its layer', () =>
    Effect.gen(function* () {
      const provided = yield* AgentRunner

      const error = yield* Effect.flip(provided.run(uncontainedLaunch))

      expect(error.category).toBe('workspace_rejected')
      expect(provided.kind).toBe('codex')
    }).pipe(Effect.provide(layerCodexAgentRunner), Effect.provide(hostFileSystem)),
  )

  // The reading itself stayed with Codex; what changed is that its result travels on the event as
  // the lifecycle outcome rather than being asked for afterwards by the runtime.
  it('reads its own turn statuses as port outcomes', (): void => {
    expect(codexTurnOutcome('completed')).toBe('completed')
    expect(codexTurnOutcome('cancelled')).toBe('cancelled')
    expect(codexTurnOutcome('canceled')).toBe('cancelled')
    expect(codexTurnOutcome('interrupted')).toBe('cancelled')
    expect(codexTurnOutcome('failed')).toBe('failed')
    expect(codexTurnOutcome('anything else')).toBe('failed')
  })
})
