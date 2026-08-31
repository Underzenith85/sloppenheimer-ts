import { Effect } from 'effect'
import { createServer, request } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import { issueId, issueIdentifier } from '../../src/domain/domain.js'
import { TrackerError } from '../../src/errors.js'
import type { OperatorBackend } from '../../src/operator/operator.js'
import type { AgentDetailLookup, OrchestratorSnapshot } from '../../src/core/orchestrator.js'
import { startOperatorServer } from '../../src/operator/server.js'
import {
  buildAgentDetail,
  createAgentDetailRecord,
  recordAgentEvent,
  type AgentDetailSnapshot,
} from '../../src/telemetry.js'

const snapshot: OrchestratorSnapshot = {
  generatedAt: '2026-08-29T12:00:00.000Z',
  workflowPath: '/tmp/WORKFLOW.md',
  effectiveWorkflow: {
    fingerprint: 'valid-workflow',
    loadedAt: '2026-08-29T11:00:00.000Z',
  },
  workflowReloadError: null,
  handoffRecovery: {
    status: 'completed',
    loaded: 1,
    recovered: 0,
    skipped: 0,
    failed: 0,
    storeError: null,
  },
  pollingIntervalMs: 10_000,
  maxConcurrentAgents: 2,
  counts: { running: 1, retrying: 0, completed: 3 },
  pausedIssueNumbers: [],
  handoffs: [
    {
      issueId: '9',
      identifier: 'example/symphony#9',
      pullRequestUrl: 'https://github.com/example/symphony/pull/44',
      branchName: 'symphony/issue-9',
      state: 'awaiting_checks',
      headSha: null,
      reason: 'Required CI checks are still running',
      repairAttempts: 0,
      observedAt: '2026-08-29T12:00:00.000Z',
    },
  ],
  running: [
    {
      issueId: issueId('17'),
      identifier: 'example/symphony#17',
      title: 'Operator console',
      url: 'https://github.com/example/symphony/issues/17',
      attempt: null,
      startedAt: '2026-08-29T11:59:00.000Z',
      lastEventAt: null,
      lastEvent: null,
      lastMessage: null,
      processId: 42,
      threadId: 'thread-1',
      turnId: 'turn-1',
      sessionId: 'thread-1-turn-1',
      turnCount: 1,
      tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      lastReportedTokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      workerHost: 'local',
      stallDeadline: '2026-08-29T12:04:00.000Z',
      detailUrl: '/api/v1/agents/example%2Fsymphony%2317',
    },
  ],
  retrying: [],
  completed: [],
  saturatedStates: [],
  inspectableAgents: [],
  totals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 60 },
  rateLimits: null,
}

const makeDetail = (identifier: string): AgentDetailSnapshot => {
  let record = createAgentDetailRecord({
    issueId: issueId('17'),
    identifier: issueIdentifier(identifier),
    title: 'Operator console',
    url: 'https://github.com/example/symphony/issues/17',
    attempt: null,
    startedAt: new Date('2026-08-29T11:59:00.000Z'),
    workspacePathKey: 'example_symphony_17',
    expectedBranch: 'symphony/issue-17',
    dispatchLabels: ['symphony'],
  })
  record = recordAgentEvent(record, {
    event: 'item/completed',
    timestamp: new Date('2026-08-29T11:59:30.000Z'),
    processId: 42,
    message: null,
    usage: null,
    rateLimits: null,
    threadId: 'thread-1',
    turnId: 'turn-1',
    sessionId: 'thread-1:turn-1',
    turnCount: 1,
    turnStatus: null,
    payload: {
      kind: 'command',
      program: 'pnpm',
      argumentCount: 1,
      quality: 'check',
      state: 'started',
      exitCode: null,
      durationMs: null,
    },
  })
  return buildAgentDetail(record, {
    self: `/api/v1/agents/${encodeURIComponent(identifier)}`,
    now: new Date('2026-08-29T12:00:00.000Z'),
    status: 'running',
    stallTimeoutMs: 60_000,
    workerHost: 'local',
    branch: 'symphony/issue-17',
    retry: null,
  })
}

const detailLookups = new Map<string, AgentDetailLookup>([
  ['example/symphony#17', { _tag: 'Found', detail: makeDetail('example/symphony#17') }],
  [
    'example/symphony#18',
    {
      _tag: 'Found',
      detail: { ...makeDetail('example/symphony#18'), status: 'retrying' },
    },
  ],
  ['example/symphony#19', { _tag: 'Completed', identifier: 'example/symphony#19' }],
  [
    // A GitHub owner and repository can together run well past a hundred characters; the endpoint
    // must accept every identifier the runtime snapshot publishes a link for.
    `${'o'.repeat(39)}/${'r'.repeat(100)}#7`,
    { _tag: 'Found', detail: makeDetail(`${'o'.repeat(39)}/${'r'.repeat(100)}#7`) },
  ],
  ['example/symphony#20', { _tag: 'NoSession', identifier: 'example/symphony#20' }],
  [
    'example/symphony#21',
    {
      _tag: 'Unavailable',
      identifier: 'example/symphony#21',
      reason: 'The agent session is still starting',
    },
  ],
])

const makeBackend = (setIssueEnabled = vi.fn()): OperatorBackend => ({
  snapshot: Effect.succeed(snapshot),
  refresh: Effect.void,
  agentDetail: (identifier) =>
    Effect.succeed(detailLookups.get(identifier) ?? { _tag: 'Unknown', identifier }),
  backlog: Effect.succeed({
    controlLabel: 'symphony',
    issues: [
      {
        number: 17,
        identifier: 'example/symphony#17',
        title: 'Operator console',
        url: 'https://github.com/example/symphony/issues/17',
        labels: ['symphony'],
        priority: 1,
        createdAt: '2026-08-29T10:00:00.000Z',
        enabled: true,
        state: 'open',
        normalizedState: 'open',
        blockedBy: [],
        readiness: 'ready',
        reason: null,
        unlocks: 0,
      },
    ],
    nodes: [
      {
        identifier: 'example/symphony#17',
        number: 17,
        title: 'Operator console',
        url: 'https://github.com/example/symphony/issues/17',
        state: 'open',
        readiness: 'ready',
        reason: null,
        actionable: true,
      },
    ],
    edges: [],
    cycles: [],
  }),
  setIssueEnabled: (number, enabled) =>
    Effect.sync(() => {
      setIssueEnabled(number, enabled)
    }),
})

const withServer = <Value>(
  backend: OperatorBackend,
  use: (url: string) => Promise<Value>,
): Promise<Value> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startOperatorServer(0, backend)
        return yield* Effect.promise(() => use(server.url))
      }),
    ),
  )

describe('operator server', (): void => {
  it('serves the console and versioned runtime state on loopback', async (): Promise<void> => {
    await withServer(makeBackend(), async (url) => {
      const page = await fetch(url)
      const state = await fetch(`${url}/api/v1/state`)
      const backlog = await fetch(`${url}/api/v1/backlog`)
      const script = await fetch(`${url}/app.js`)
      const detail = await fetch(`${url}/api/v1/${encodeURIComponent('example/symphony#17')}`)

      expect(page.status).toBe(200)
      expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
      expect(await page.text()).toContain('Work by state')
      expect(state.status).toBe(200)
      expect(await state.json()).toMatchObject({ counts: { running: 1 }, maxConcurrentAgents: 2 })
      expect(await backlog.json()).toMatchObject({
        nodes: [{ identifier: 'example/symphony#17', readiness: 'ready' }],
        edges: [],
        cycles: [],
      })
      expect(await detail.json()).toMatchObject({ identifier: 'example/symphony#17' })
      const source = await script.text()
      expect(source).toContain("'graph-node state-' + statusClass(status)")
      expect(source).toContain("awaiting_checks: 'Awaiting checks'")
      expect(source).toContain("closed_without_merge: 'Closed without merge'")
      expect(source).toContain(
        '(state?.handoffs ?? []).find((entry) => entry.identifier === node.identifier)',
      )
      // The served bundle is the whole console, in dependency order: the view model, the shared
      // browser primitives, the detail overlay and the shell.
      expect(source).toContain("start: 'Start agent'")
      expect(source).toContain('const buildWorkModel =')
      expect(source).toContain('const installDetailControls =')
      expect(source.indexOf('const buildWorkModel =')).toBeLessThan(
        source.indexOf('const installDetailControls ='),
      )
    })
  })

  it('serves agent detail for a running agent without leaking the workspace or prompt', async (): Promise<void> => {
    await withServer(makeBackend(), async (url) => {
      const response = await fetch(
        `${url}/api/v1/agents/${encodeURIComponent('example/symphony#17')}`,
      )
      const body = await response.text()
      const payload: unknown = JSON.parse(body)

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(payload).toMatchObject({
        version: 'v1',
        detail: {
          version: 'v1',
          self: '/api/v1/agents/example%2Fsymphony%2317',
          identifier: 'example/symphony#17',
          status: 'running',
          identity: { threadId: 'thread-1', turnId: 'turn-1', processId: 42, workerHost: 'local' },
          phase: { phase: 'running_command', operation: 'Running pnpm' },
          activity: { stallTimeoutMs: 60_000, stalled: false },
          workspace: { pathKey: 'example_symphony_17', qualityPhase: 'check' },
          handoff: { expectedBranch: 'symphony/issue-17', outcome: 'in_progress' },
          timeline: { retained: 1, dropped: 0, limit: 200 },
        },
      })
      expect(body).not.toContain('/tmp/')
    })
  })

  it('distinguishes retrying, completed, sessionless, unavailable, missing, and malformed detail requests', async (): Promise<void> => {
    await withServer(makeBackend(), async (url) => {
      const detailFor = (identifier: string): Promise<Response> =>
        fetch(`${url}/api/v1/agents/${encodeURIComponent(identifier)}`)
      const retrying = await detailFor('example/symphony#18')
      const completed = await detailFor('example/symphony#19')
      const sessionless = await detailFor('example/symphony#20')
      const unavailable = await detailFor('example/symphony#21')
      const missing = await detailFor('example/symphony#99')
      const malformed = await detailFor('not an identifier')
      const longIdentifier = await detailFor(`${'o'.repeat(39)}/${'r'.repeat(100)}#7`)
      const wrongMethod = await fetch(
        `${url}/api/v1/agents/${encodeURIComponent('example/symphony#17')}`,
        { method: 'POST' },
      )

      expect(retrying.status).toBe(200)
      expect(await retrying.json()).toMatchObject({ detail: { status: 'retrying' } })
      expect(completed.status).toBe(410)
      expect(await completed.json()).toMatchObject({
        version: 'v1',
        error: { code: 'agent_session_completed' },
      })
      expect(sessionless.status).toBe(409)
      expect(await sessionless.json()).toMatchObject({ error: { code: 'agent_not_active' } })
      expect(unavailable.status).toBe(503)
      expect(unavailable.headers.get('retry-after')).toBe('1')
      expect(await unavailable.json()).toMatchObject({
        error: { code: 'agent_detail_unavailable' },
      })
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({ error: { code: 'agent_not_found' } })
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toMatchObject({ error: { code: 'invalid_identifier' } })
      expect(longIdentifier.status).toBe(200)
      expect(wrongMethod.status).toBe(405)
    })
  })

  it('requires its page token before changing issue eligibility', async (): Promise<void> => {
    const setIssueEnabled = vi.fn()
    await withServer(makeBackend(setIssueEnabled), async (url) => {
      const rejected = await fetch(`${url}/api/v1/issues/17/pause`, { method: 'POST' })
      expect(rejected.status).toBe(403)

      const page = await (await fetch(url)).text()
      const token = /name="csrf-token" content="([^"]+)"/u.exec(page)?.[1]
      expect(token).toBeDefined()
      const accepted = await fetch(`${url}/api/v1/issues/17/pause`, {
        method: 'POST',
        headers: { 'X-Symphony-CSRF': token ?? '' },
      })

      expect(accepted.status).toBe(202)
      expect(setIssueEnabled).toHaveBeenCalledWith(17, false)
    })
  })

  it('returns explicit 404 and 405 responses', async (): Promise<void> => {
    await withServer(makeBackend(), async (url) => {
      const missing = await fetch(`${url}/missing`)
      const wrongMethod = await fetch(`${url}/api/v1/state`, { method: 'POST' })
      const invalidAction = await fetch(`${url}/api/v1/issues/not-a-number/start`, {
        method: 'POST',
      })

      expect(missing.status).toBe(404)
      expect(wrongMethod.status).toBe(405)
      expect(wrongMethod.headers.get('allow')).toBe('GET')
      expect(invalidAction.status).toBe(404)
    })
  })

  it('rejects non-loopback host headers', async (): Promise<void> => {
    await withServer(makeBackend(), async (url) => {
      const target = new URL(url)
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = request(
          {
            hostname: target.hostname,
            port: target.port,
            headers: { Host: 'attacker.example' },
          },
          (response) => {
            response.resume()
            resolve(response.statusCode ?? 0)
          },
        )
        outgoing.once('error', reject)
        outgoing.end()
      })

      expect(status).toBe(421)
    })
  })

  it('sanitizes typed backend failures as versioned 502 responses', async (): Promise<void> => {
    const backend: OperatorBackend = {
      ...makeBackend(),
      backlog: Effect.fail(
        new TrackerError({
          category: 'tracker_request',
          message: 'sensitive backend detail',
          retryable: true,
        }),
      ),
    }

    await withServer(backend, async (url) => {
      const response = await fetch(`${url}/api/v1/backlog`)
      const body = await response.text()

      expect(response.status).toBe(502)
      expect(JSON.parse(body)).toEqual({
        version: 'v1',
        error: {
          code: 'backend_error',
          message: 'The operator backend could not complete the request',
        },
      })
      expect(body).not.toContain('sensitive backend detail')
    })
  })

  it('sanitizes unexpected defects as versioned 500 responses', async (): Promise<void> => {
    const backend: OperatorBackend = {
      ...makeBackend(),
      snapshot: Effect.die(new Error('sensitive defect detail')),
    }

    await withServer(backend, async (url) => {
      const response = await fetch(`${url}/api/v1/state`)
      const body = await response.text()

      expect(response.status).toBe(500)
      expect(JSON.parse(body)).toEqual({
        version: 'v1',
        error: { code: 'internal_error', message: 'The request could not be completed' },
      })
      expect(body).not.toContain('sensitive defect detail')
    })
  })

  it('represents listen failures as ServerError', async (): Promise<void> => {
    const occupied = createServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', resolve)
    })
    const address = occupied.address()
    if (address === null || typeof address === 'string') {
      throw new Error('test server did not expose a TCP address')
    }

    try {
      const result = await Effect.runPromise(
        Effect.either(Effect.scoped(startOperatorServer(address.port, makeBackend()))),
      )
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left._tag).toBe('ServerError')
        expect(result.left.category).toBe('listen_failed')
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    }
  })

  it('stops accepting connections when its scope closes', async (): Promise<void> => {
    let url = ''
    await Effect.runPromise(
      Effect.scoped(
        Effect.map(startOperatorServer(0, makeBackend()), (server) => {
          url = server.url
        }),
      ),
    )

    await expect(fetch(url)).rejects.toThrow()
  })
})
