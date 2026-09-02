import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'

import { issueId } from '@sloppenheimer/core/domain/domain.js'
import { parseCliArguments } from '../../src/config/cli-options.js'
import type { OperatorBackend } from '../../src/operator/operator.js'
import type { OrchestratorSnapshot } from '@sloppenheimer/core'
import { startOperatorServer } from '../../src/operator/server.js'

const tokens = { inputTokens: 12, outputTokens: 8, totalTokens: 20 } as const

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
  counts: { running: 1, retrying: 1, delivering: 0, completed: 0 },
  completed: [],
  saturatedStates: [],
  inspectableAgents: [],
  pausedIssueNumbers: [],
  handoffs: [
    {
      issueId: '31',
      identifier: 'example/sloppenheimer#31',
      pullRequestUrl: 'https://example.test/pull/62',
      branchName: 'sloppenheimer/issue-31',
      state: 'awaiting_checks',
      headSha: null,
      reason: null,
      repairAttempts: 0,
      observedAt: '2026-08-29T00:00:00.000Z',
    },
  ],
  running: [
    {
      issueId: issueId('17'),
      identifier: 'example/sloppenheimer#17',
      title: 'Operator console',
      url: 'https://example.test/issues/17',
      state: 'in_progress',
      attempt: null,
      startedAt: '2026-08-28T23:59:00.000Z',
      lastEventAt: '2026-08-28T23:59:30.000Z',
      lastEvent: 'item/completed',
      lastMessage: null,
      processId: 42,
      threadId: 'thread-1',
      turnId: 'turn-1',
      sessionId: 'thread-1-turn-1',
      turnCount: 1,
      tokens,
      lastReportedTokens: tokens,
      workerHost: 'local',
      stallDeadline: '2026-08-29T00:05:00.000Z',
      detailUrl: '/api/v1/agents/example%2Fsloppenheimer%2317',
    },
  ],
  delivering: [],
  retrying: [
    {
      issueId: issueId('18'),
      identifier: 'example/sloppenheimer#18',
      title: 'Flaky dependency',
      url: 'https://example.test/issues/18',
      attempt: 2,
      dueAt: '2026-08-29T00:00:20.000Z',
      error: 'turn failed',
      workerHost: 'local',
      detailUrl: '/api/v1/agents/example%2Fsloppenheimer%2318',
    },
  ],
  totals: { ...tokens, secondsRunning: 60 },
  rateLimits: null,
}

const backend: OperatorBackend = {
  snapshot: Effect.succeed(snapshot),
  refresh: Effect.succeed({
    coalesced: true,
    requestedAt: '2026-08-29T00:00:00.000Z',
    operations: ['issue_reconciliation', 'dispatch'],
  }),
  agentDetail: (identifier) => Effect.succeed({ _tag: 'Unknown', identifier }),
  backlog: Effect.succeed({
    controlLabel: 'sloppenheimer',
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
        workflow_path: '/isolated/WORKFLOW.md',
        counts: { running: 1 },
      })
    }),
  )

  // SPEC 13.7.2 names the baseline document; the runtime's internal record is not it, and the
  // difference is exactly what the serialization boundary exists to absorb.
  it.scopedLive('publishes the SPEC 13.7.2 baseline field names', () =>
    Effect.gen(function* () {
      const server = yield* startOperatorServer(0, backend)
      const response = yield* Effect.promise(() => fetch(`${server.url}/api/v1/state`))
      const payload = yield* Effect.promise(
        () => response.json() as Promise<Record<string, unknown>>,
      )

      expect(payload).toMatchObject({
        generated_at: '2026-08-29T00:00:00.000Z',
        running: [
          {
            issue_id: '17',
            issue_identifier: 'example/sloppenheimer#17',
            issue_url: 'https://example.test/issues/17',
            state: 'in_progress',
            session_id: 'thread-1-turn-1',
            worker_host: 'local',
            tokens: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
            detail_url: '/api/v1/agents/example%2Fsloppenheimer%2317',
          },
        ],
        retrying: [
          {
            issue_identifier: 'example/sloppenheimer#18',
            attempt: 2,
            due_at: '2026-08-29T00:00:20.000Z',
            error: 'turn failed',
          },
        ],
        codex_totals: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20,
          seconds_running: 60,
        },
      })
      // The internal camelCase record is not what the API publishes.
      expect(payload['generatedAt']).toBeUndefined()
      expect(payload['totals']).toBeUndefined()
      const [running] = payload['running'] as readonly Record<string, unknown>[]
      expect(Object.keys(running ?? {})).not.toContain('identifier')
    }),
  )

  it.scopedLive('publishes the per-issue baseline for every issue in-memory state knows', () =>
    Effect.gen(function* () {
      const server = yield* startOperatorServer(0, backend)
      const detailFor = (identifier: string): Promise<Response> =>
        fetch(`${server.url}/api/v1/${encodeURIComponent(identifier)}`)

      // Handed-off work has no agent session behind it, and is still known to this host.
      const handedOff = yield* Effect.promise(() => detailFor('example/sloppenheimer#31'))
      expect(handedOff.status).toBe(200)
      expect(yield* Effect.promise(() => handedOff.json())).toMatchObject({
        self: '/api/v1/example%2Fsloppenheimer%2331',
        issue_identifier: 'example/sloppenheimer#31',
        issue_id: '31',
        status: 'handoff',
        tracked: true,
        workspace: { path: null },
        attempts: { restart_count: 0, current_retry_attempt: 0 },
        running: null,
        retry: null,
        logs: { retained: 0, dropped: 0, limit: 200, published: 0 },
        recent_events: [],
        last_error: null,
        detail_url: '/api/v1/agents/example%2Fsloppenheimer%2331',
      })

      // The running row stands in where the actor has published no detail record.
      const running = yield* Effect.promise(() => detailFor('example/sloppenheimer#17'))
      expect(yield* Effect.promise(() => running.json())).toMatchObject({
        status: 'running',
        tracked: true,
        running: { session_id: 'thread-1-turn-1', tokens: { total_tokens: 20 } },
      })

      const unknown = yield* Effect.promise(() => detailFor('example/sloppenheimer#404'))
      expect(unknown.status).toBe(404)
      expect(yield* Effect.promise(() => unknown.json())).toMatchObject({
        version: 'v1',
        error: { code: 'issue_not_found' },
      })
    }),
  )

  it.scopedLive('acknowledges a refresh with the suggested 202 body', () =>
    Effect.gen(function* () {
      const server = yield* startOperatorServer(0, backend)
      const page = yield* Effect.promise(async () => (await fetch(server.url)).text())
      const token = /name="csrf-token" content="([^"]+)"/u.exec(page)?.[1] ?? ''
      const response = yield* Effect.promise(() =>
        fetch(`${server.url}/api/v1/refresh`, {
          method: 'POST',
          headers: { 'X-Sloppenheimer-CSRF': token },
        }),
      )
      const payload = yield* Effect.promise(() => response.json())

      expect(response.status).toBe(202)
      expect(payload).toEqual({
        queued: true,
        coalesced: true,
        requested_at: '2026-08-29T00:00:00.000Z',
        operations: ['issue_reconciliation', 'dispatch'],
      })
    }),
  )
})
