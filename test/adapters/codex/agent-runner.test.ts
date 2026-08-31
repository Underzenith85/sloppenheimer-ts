import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'

import {
  codexAgentEventSemantics,
  codexAgentRunner,
  layerCodexAgentRunner,
} from '@symphony/adapter-codex/agent-runner.js'
import { issueId, issueIdentifier, type Issue } from '@symphony/core/domain/domain.js'
import type { CodexConfig } from '@symphony/core/config/workflow.js'
import type { AgentLaunch } from '@symphony/adapter-codex/codex.js'
import { AgentRunner, type AgentRunnerPort } from '@symphony/core/ports/agent-runner.js'
import { hostFileSystem } from '../../harness/filesystem.js'

const codexConfig: CodexConfig = {
  command: 'codex app-server',
  approvalPolicy: 'never',
  threadSandbox: 'workspace-write',
  turnSandboxPolicy: null,
  turnTimeoutMs: 1_000,
  readTimeoutMs: 1_000,
  stallTimeoutMs: 1_000,
}

const issue: Issue = {
  id: issueId('19'),
  nativeRef: null,
  identifier: issueIdentifier('example/symphony#19'),
  title: 'Bind the runner to a filesystem',
  description: null,
  priority: null,
  state: 'open',
  branchName: null,
  url: null,
  assigneeId: null,
  labels: [],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
}

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
      expect(runner.semantics).toBe(codexAgentEventSemantics)
    }),
  )

  it.effect('provides the agent runner tag from its layer', () =>
    Effect.gen(function* () {
      const provided = yield* AgentRunner

      const error = yield* Effect.flip(provided.run(uncontainedLaunch))

      expect(error.category).toBe('workspace_rejected')
      expect(provided.semantics).toBe(codexAgentEventSemantics)
    }).pipe(Effect.provide(layerCodexAgentRunner), Effect.provide(hostFileSystem)),
  )

  it('reads Codex turn statuses as port outcomes', (): void => {
    const { turnOutcome } = codexAgentEventSemantics

    expect(turnOutcome('completed')).toBe('completed')
    expect(turnOutcome('cancelled')).toBe('cancelled')
    expect(turnOutcome('canceled')).toBe('cancelled')
    expect(turnOutcome('interrupted')).toBe('cancelled')
    expect(turnOutcome('failed')).toBe('failed')
    expect(turnOutcome('anything else')).toBe('failed')
  })
})
