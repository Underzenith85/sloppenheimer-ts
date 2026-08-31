import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'

import { parseCliArguments } from '../../src/config/cli-options.js'
import type { OperatorBackend } from '../../src/operator/operator.js'
import type { OrchestratorSnapshot } from '../../src/core/orchestrator.js'
import { startOperatorServer } from '../../src/operator/server.js'

const snapshot: OrchestratorSnapshot = {
  generatedAt: '2026-08-29T00:00:00.000Z',
  workflowPath: '/isolated/WORKFLOW.md',
  effectiveWorkflow: { fingerprint: 'extension', loadedAt: '2026-08-29T00:00:00.000Z' },
  workflowReloadError: null,
  handoffRecovery: {
    status: 'completed',
    loaded: 0,
    recovered: 0,
    skipped: 0,
    failed: 0,
    storeError: null,
  },
  pollingIntervalMs: 30_000,
  maxConcurrentAgents: 1,
  counts: { running: 0, retrying: 0, completed: 0 },
  completed: [],
  saturatedStates: [],
  inspectableAgents: [],
  pausedIssueNumbers: [],
  handoffs: [],
  running: [],
  retrying: [],
  totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
  rateLimits: null,
}

const backend: OperatorBackend = {
  snapshot: Effect.succeed(snapshot),
  refresh: Effect.void,
  agentDetail: (identifier) => Effect.succeed({ _tag: 'Unknown', identifier }),
  backlog: Effect.succeed({
    controlLabel: 'symphony',
    issues: [],
    nodes: [],
    edges: [],
    cycles: [],
  }),
  setIssueEnabled: () => Effect.void,
}

describe('Extension Conformance: HTTP status surface', (): void => {
  it('accepts a CLI port override independently of workflow selection', (): void => {
    expect(parseCliArguments(['--port', '4321', './workflow.md']).port).toBe(4_321)
  })

  // `scopedLive`: the server binds a real loopback socket that a real `fetch` then calls.
  it.scopedLive('binds loopback and serves state owned by the orchestrator', () =>
    Effect.gen(function* () {
      const server = yield* startOperatorServer(0, backend)
      expect(new URL(server.url).hostname).toBe('127.0.0.1')
      const response = yield* Effect.promise(() => fetch(`${server.url}/api/v1/state`))
      const payload = yield* Effect.promise(() => response.json())
      expect(payload).toMatchObject({
        workflowPath: '/isolated/WORKFLOW.md',
        counts: { running: 0 },
      })
    }),
  )
})
