import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { workflowDefaults, type Workflow } from '@sloppenheimer/core/config/workflow.js'
import { issueId } from '@sloppenheimer/core/domain/domain.js'
import { createSnapshot } from '@sloppenheimer/core/core/snapshot.js'
import {
  initialState,
  publishedCompletedWork,
  type CompletedSnapshot,
  type EffectiveWorkflow,
} from '@sloppenheimer/core/core/state.js'
import { stubProvider } from '../harness/stub-tracker-provider.js'
import { auroraRunner } from '../harness/alien-agent-runner.js'

/**
 * The operator's view of one instant, as a function of the state it is given. No orchestrator and
 * no ports: the snapshot reads the state and the workflow in force, and nothing else.
 */
const workflow: Workflow = {
  path: '/tmp/WORKFLOW.md',
  fingerprint: 'test',
  promptTemplate: 'test',
  tracker: stubProvider('token'),
  runner: auroraRunner(),
  config: {
    tracker: {
      kind: 'stub',
      provider: { token: 'token' },
      requiredLabels: ['sloppenheimer'],
      activeStates: ['open'],
      terminalStates: ['closed'],
    },
    pollingIntervalMs: 30_000,
    workspaceRoot: '/tmp/sloppenheimer',
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 1,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: new Map(),
    },
    runner: {
      command: 'codex app-server',
      turnTimeoutMs: 60_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 30_000,
      settings: { tempo: 'largo' },
    },
    serverPort: null,
    trace: workflowDefaults.trace,
    handoffEnabled: true,
    extensions: {},
  },
}

/** The snapshot never calls a port, so the effective workflow only has to be the right shape. */
const effective: EffectiveWorkflow = {
  ...({
    tracker: { secretEnvironmentNames: [] },
    codeReview: Option.none(),
    workspaces: {},
  } as unknown as Omit<EffectiveWorkflow, 'workflow' | 'loadedAt'>),
  workflow,
  loadedAt: new Date('2026-01-01T00:00:00.000Z'),
}

const finished = (index: number): CompletedSnapshot => ({
  issueId: issueId(`example/sloppenheimer#${index}`),
  identifier: `example/sloppenheimer#${index}`,
  title: `example/sloppenheimer#${index}`,
  url: null,
  outcome: 'merged',
  finishedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
  pullRequestUrl: null,
})

describe('operator snapshot counts', (): void => {
  it('counts the finished work it publishes, not what it holds back', (): void => {
    const state = initialState(effective, {
      handoffs: [],
      // One more than the bound, so the count and the list can disagree if the count is taken
      // from anywhere but the list.
      completions: Array.from({ length: publishedCompletedWork + 1 }, (_, index) =>
        finished(index),
      ),
      storeReadFailed: false,
      storeError: null,
    })

    const snapshot = createSnapshot(state, '/tmp/WORKFLOW.md', Date.UTC(2026, 0, 2))

    expect(snapshot.completed).toHaveLength(publishedCompletedWork)
    expect(snapshot.counts.completed).toBe(snapshot.completed.length)
  })
})
