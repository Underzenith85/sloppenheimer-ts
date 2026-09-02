import { createServer, request } from 'node:http'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect, vi } from 'vitest'

import { issueId, issueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import { isJsonObject, type JsonObject } from '@sloppenheimer/core/support/json.js'
import type { ServerError } from '@sloppenheimer/core/domain/errors.js'
import type { HandoffSnapshot } from '@sloppenheimer/core/domain/handoff.js'
import { TrackerError } from '@sloppenheimer/core/domain/errors.js'
import { issueDetailPath } from '../../src/operator/api.js'
import { operatorRoutes } from '../../src/operator/api/endpoints.js'
import { operatorOpenApiDocument } from '../../src/operator/openapi.js'
import type { OperatorBackend } from '../../src/operator/operator.js'
import type { AgentDetailLookup, OrchestratorSnapshot } from '@sloppenheimer/core'
import { startOperatorServer } from '../../src/operator/server.js'
import {
  buildAgentDetail,
  createAgentDetailRecord,
  recordAgentEvent,
  type AgentDetailSnapshot,
} from '@sloppenheimer/core/telemetry.js'

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
  counts: { running: 1, retrying: 0, delivering: 0, completed: 3 },
  pausedIssueNumbers: [],
  handoffs: [
    {
      issueId: '9',
      identifier: 'example/sloppenheimer#9',
      pullRequestUrl: 'https://github.com/example/sloppenheimer/pull/44',
      branchName: 'sloppenheimer/issue-9',
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
      identifier: 'example/sloppenheimer#17',
      title: 'Operator console',
      url: 'https://github.com/example/sloppenheimer/issues/17',
      state: 'open',
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
      detailUrl: '/api/v1/agents/example%2Fsloppenheimer%2317',
    },
  ],
  retrying: [],
  delivering: [],
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
    url: 'https://github.com/example/sloppenheimer/issues/17',
    attempt: null,
    startedAt: new Date('2026-08-29T11:59:00.000Z'),
    workspacePathKey: 'example_sloppenheimer_17',
    expectedBranch: 'sloppenheimer/issue-17',
    dispatchLabels: ['sloppenheimer'],
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
    lifecycle: null,
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
    handoffEnabled: true,
    branch: 'sloppenheimer/issue-17',
    retry: null,
  })
}

const detailLookups = new Map<string, AgentDetailLookup>([
  ['example/sloppenheimer#17', { _tag: 'Found', detail: makeDetail('example/sloppenheimer#17') }],
  [
    'example/sloppenheimer#18',
    {
      _tag: 'Found',
      detail: { ...makeDetail('example/sloppenheimer#18'), status: 'retrying' },
    },
  ],
  ['example/sloppenheimer#19', { _tag: 'Completed', identifier: 'example/sloppenheimer#19' }],
  [
    // A GitHub owner and repository can together run well past a hundred characters; the endpoint
    // must accept every identifier the runtime snapshot publishes a link for.
    `${'o'.repeat(39)}/${'r'.repeat(100)}#7`,
    { _tag: 'Found', detail: makeDetail(`${'o'.repeat(39)}/${'r'.repeat(100)}#7`) },
  ],
  ['example/sloppenheimer#20', { _tag: 'NoSession', identifier: 'example/sloppenheimer#20' }],
  [
    'example/sloppenheimer#21',
    {
      _tag: 'Unavailable',
      identifier: 'example/sloppenheimer#21',
      reason: 'The agent session is still starting',
    },
  ],
])

const makeBackend = (setIssueEnabled = vi.fn()): OperatorBackend => ({
  snapshot: Effect.succeed(snapshot),
  refresh: Effect.succeed({
    coalesced: false,
    requestedAt: '2026-08-29T12:00:00.000Z',
    operations: ['issue_reconciliation', 'dispatch'],
  }),
  agentDetail: (identifier) =>
    Effect.succeed(detailLookups.get(identifier) ?? { _tag: 'Unknown', identifier }),
  backlog: Effect.succeed({
    controlLabel: 'sloppenheimer',
    issues: [
      {
        number: 17,
        identifier: 'example/sloppenheimer#17',
        title: 'Operator console',
        url: 'https://github.com/example/sloppenheimer/issues/17',
        labels: ['sloppenheimer'],
        priority: 1,
        createdAt: '2026-08-29T10:00:00.000Z',
        enabled: true,
        dispatchable: true,
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
        identifier: 'example/sloppenheimer#17',
        number: 17,
        title: 'Operator console',
        url: 'https://github.com/example/sloppenheimer/issues/17',
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

/**
 * One response body, read as the JSON object this API publishes rather than asserted to be one.
 * `Response.json` answers `unknown`, and a cast would let a case inspect fields of a body whose
 * shape was never established — which is the thing these cases exist to establish. `isJsonObject`
 * is the repository's one structural record test; a body that is not a record fails here, with the
 * body in the message, rather than as a confusing assertion further down.
 */
const jsonObjectBody = async (response: Response): Promise<JsonObject> => {
  const payload: unknown = await response.json()
  if (!isJsonObject(payload)) {
    throw new Error(`expected a JSON object body, received ${JSON.stringify(payload)}`)
  }
  return payload
}

/**
 * Serves the console on a loopback socket for the length of the case. The callback stays
 * promise-shaped: what it does is `fetch` against a real server, which is a promise boundary.
 */
const withServer = <Value>(
  backend: OperatorBackend,
  use: (url: string) => Promise<Value>,
): Effect.Effect<Value, ServerError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startOperatorServer(0, backend)
      return yield* Effect.promise(() => use(server.url))
    }),
  )

describe('operator server', (): void => {
  it.live('serves the console and versioned runtime state on loopback', () =>
    withServer(makeBackend(), async (url) => {
      const page = await fetch(url)
      const state = await fetch(`${url}/api/v1/state`)
      const backlog = await fetch(`${url}/api/v1/backlog`)
      const script = await fetch(`${url}/app.js`)
      const detail = await fetch(`${url}/api/v1/${encodeURIComponent('example/sloppenheimer#17')}`)

      expect(page.status).toBe(200)
      expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
      expect(await page.text()).toContain('Work by state')
      expect(state.status).toBe(200)
      expect(await state.json()).toMatchObject({
        counts: { running: 1 },
        max_concurrent_agents: 2,
        running: [{ issue_identifier: 'example/sloppenheimer#17', state: 'open' }],
      })
      expect(await backlog.json()).toMatchObject({
        nodes: [{ identifier: 'example/sloppenheimer#17', readiness: 'ready' }],
        edges: [],
        cycles: [],
      })
      expect(await detail.json()).toMatchObject({
        issue_identifier: 'example/sloppenheimer#17',
        status: 'running',
        detail_url: '/api/v1/agents/example%2Fsloppenheimer%2317',
        retry: null,
      })
      const source = await script.text()
      expect(source).toContain('`graph-node state-${statusClass(status)}`')
      expect(source).toContain("awaiting_checks: 'Awaiting checks'")
      expect(source).toContain("closed_without_merge: 'Closed without merge'")
      expect(source).toContain('(state?.handoffs ?? []).find(')
      expect(source).toContain('entry.issue_identifier === node.identifier')
      // The served bundle is the whole console, in dependency order: the view model, the shared
      // browser primitives, the detail overlay and the shell.
      expect(source).toContain("start: 'Start agent'")
      expect(source).toContain('const buildWorkModel =')
      expect(source).toContain('const installDetailControls =')
      expect(source.indexOf('const buildWorkModel =')).toBeLessThan(
        source.indexOf('const installDetailControls ='),
      )
    }),
  )

  it.live('serves agent detail for a running agent without leaking the workspace or prompt', () =>
    withServer(makeBackend(), async (url) => {
      const response = await fetch(
        `${url}/api/v1/agents/${encodeURIComponent('example/sloppenheimer#17')}`,
      )
      const body = await response.text()
      const payload: unknown = JSON.parse(body)

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(payload).toMatchObject({
        version: 'v1',
        detail: {
          version: 'v1',
          self: '/api/v1/agents/example%2Fsloppenheimer%2317',
          identifier: 'example/sloppenheimer#17',
          status: 'running',
          identity: { threadId: 'thread-1', turnId: 'turn-1', processId: 42, workerHost: 'local' },
          phase: { phase: 'running_command', operation: 'Running pnpm' },
          activity: { stallTimeoutMs: 60_000, stalled: false },
          workspace: { pathKey: 'example_sloppenheimer_17', qualityPhase: 'check' },
          handoff: { expectedBranch: 'sloppenheimer/issue-17', outcome: 'in_progress' },
          timeline: { retained: 1, dropped: 0, limit: 200 },
        },
      })
      expect(body).not.toContain('/tmp/')
    }),
  )

  it.live(
    'distinguishes retrying, completed, sessionless, unavailable, and missing detail requests',
    () =>
      withServer(makeBackend(), async (url) => {
        const detailFor = (identifier: string): Promise<Response> =>
          fetch(`${url}/api/v1/agents/${encodeURIComponent(identifier)}`)
        const retrying = await detailFor('example/sloppenheimer#18')
        const completed = await detailFor('example/sloppenheimer#19')
        const sessionless = await detailFor('example/sloppenheimer#20')
        const unavailable = await detailFor('example/sloppenheimer#21')
        const missing = await detailFor('example/sloppenheimer#99')
        const malformed = await detailFor('not an identifier')
        const longIdentifier = await detailFor(`${'o'.repeat(39)}/${'r'.repeat(100)}#7`)
        const wrongMethod = await fetch(
          `${url}/api/v1/agents/${encodeURIComponent('example/sloppenheimer#17')}`,
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
        // Nothing this session ran is spelled that way, which is what `agent_not_found` means.
        expect(malformed.status).toBe(404)
        expect(await malformed.json()).toMatchObject({ error: { code: 'agent_not_found' } })
        expect(longIdentifier.status).toBe(200)
        expect(wrongMethod.status).toBe(405)
      }),
  )

  it.live('serves the SPEC per-issue baseline for every issue in-memory state knows', () =>
    withServer(makeBackend(), async (url) => {
      const detailFor = (identifier: string): Promise<Response> =>
        fetch(`${url}/api/v1/${encodeURIComponent(identifier)}`)
      const running = await detailFor('example/sloppenheimer#17')
      // The issue has left the agent for the pull-request lifecycle. It is as known to this host as
      // a running one, and used to be reported as absent.
      const handedOff = await detailFor('example/sloppenheimer#9')
      const retrying = await detailFor('example/sloppenheimer#18')
      const completed = await detailFor('example/sloppenheimer#19')
      const starting = await detailFor('example/sloppenheimer#21')
      const unknown = await detailFor('example/sloppenheimer#99')
      const wrongMethod = await fetch(
        `${url}/api/v1/${encodeURIComponent('example/sloppenheimer#17')}`,
        { method: 'POST' },
      )

      expect(running.status).toBe(200)
      expect(await running.json()).toMatchObject({
        self: '/api/v1/example%2Fsloppenheimer%2317',
        issue_id: '17',
        issue_identifier: 'example/sloppenheimer#17',
        issue_url: 'https://github.com/example/sloppenheimer/issues/17',
        title: 'Operator console',
        status: 'running',
        tracked: true,
        workspace: { path: 'example_sloppenheimer_17' },
        attempts: { restart_count: 0, current_retry_attempt: 0 },
        running: {
          started_at: '2026-08-29T11:59:00.000Z',
          elapsed_ms: 60_000,
          phase: 'running_command',
          operation: 'Running pnpm',
          session_id: 'thread-1:turn-1',
          process_id: 42,
          worker_host: 'local',
          stalled: false,
          tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
        retry: null,
        logs: { retained: 1, dropped: 0, limit: 200, published: 1 },
        recent_events: [{ sequence: 1, category: 'command', attempt: 0 }],
        last_error: null,
        detail_url: '/api/v1/agents/example%2Fsloppenheimer%2317',
      })

      expect(handedOff.status).toBe(200)
      expect(await handedOff.json()).toMatchObject({
        issue_identifier: 'example/sloppenheimer#9',
        status: 'handoff',
        tracked: true,
        running: null,
        workspace: { path: null },
        logs: { retained: 0, dropped: 0, published: 0 },
        recent_events: [],
      })

      expect(await retrying.json()).toMatchObject({ status: 'retrying', tracked: true })
      // Retained history rather than live work: the session finished and aged out of retention.
      expect(await completed.json()).toMatchObject({ status: 'completed', tracked: false })
      expect(await starting.json()).toMatchObject({ status: 'starting', tracked: true })
      expect(unknown.status).toBe(404)
      expect(await unknown.json()).toMatchObject({
        version: 'v1',
        error: { code: 'issue_not_found' },
      })
      expect(wrongMethod.status).toBe(405)
      expect(wrongMethod.headers.get('allow')).toBe('GET')
    }),
  )

  /*
   * The snapshot and the detail are two reads of the actor's state, so an agent that fails between
   * them leaves a stale running row beside a fresh retrying detail. The response must be one
   * source's reading rather than a blend: a `running` block beside a pending `retry`, under a
   * status only one of them supports, is a state the host was never in.
   */
  it.live('never blends a stale snapshot row with a fresher detail record', () =>
    Effect.gen(function* () {
      const retryingDetail: AgentDetailSnapshot = {
        ...makeDetail('example/sloppenheimer#17'),
        status: 'retrying',
        retry: { attempt: 2, dueAt: '2026-08-29T12:01:00.000Z', reason: 'turn failed' },
      }
      const skewed: OperatorBackend = {
        ...makeBackend(),
        // The row still says running; the detail read a moment later says the agent has failed.
        agentDetail: () => Effect.succeed({ _tag: 'Found', detail: retryingDetail }),
      }
      yield* withServer(skewed, async (url) => {
        const response = await fetch(
          `${url}/api/v1/${encodeURIComponent('example/sloppenheimer#17')}`,
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          status: 'retrying',
          tracked: true,
          running: null,
          retry: { attempt: 2, due_at: '2026-08-29T12:01:00.000Z', reason: 'turn failed' },
        })
      })
    }),
  )

  /*
   * A running row publishes its stall deadline rather than a flag, so that a reader can decide the
   * deadline has passed without waiting for the next snapshot to say so. The fallback must make
   * that decision rather than reporting an already-stalled agent as healthy beside the deadline
   * that contradicts it.
   */
  it.live('derives the fallback stall flag from the deadline the row carries', () =>
    Effect.gen(function* () {
      const stalled: OperatorBackend = {
        ...makeBackend(),
        snapshot: Effect.succeed({
          ...snapshot,
          // The deadline passed a minute before this snapshot was taken.
          generatedAt: '2026-08-29T12:05:00.000Z',
        }),
        // No detail record, so the running row stands in.
        agentDetail: (identifier) =>
          Effect.succeed({ _tag: 'Unavailable', identifier, reason: 'x' }),
      }
      yield* withServer(stalled, async (url) => {
        const response = await fetch(
          `${url}/api/v1/${encodeURIComponent('example/sloppenheimer#17')}`,
        )
        expect(await response.json()).toMatchObject({
          status: 'running',
          running: { stall_deadline: '2026-08-29T12:04:00.000Z', stalled: true },
        })
      })
    }),
  )

  /*
   * A queued retry is not a restart that happened. The runtime queues one as `(attempt ?? 0) + 1`,
   * so a retrying row names the attempt scheduled next, while the detail record advances its
   * counters only when an attempt actually starts. The fallback must answer on the record's terms,
   * or the same issue reports a different history depending on whether a record was retained.
   */
  it.live('does not count a pending retry as a restart that already happened', () =>
    Effect.gen(function* () {
      const queued: OperatorBackend = {
        ...makeBackend(),
        snapshot: Effect.succeed({
          ...snapshot,
          running: [],
          retrying: [
            {
              issueId: issueId('31'),
              identifier: 'example/sloppenheimer#31',
              title: 'Awaiting its first retry',
              url: null,
              // The first attempt failed; attempt 1 is scheduled and has not begun.
              attempt: 1,
              dueAt: '2026-08-29T12:01:00.000Z',
              error: 'turn failed',
              workerHost: 'local',
              detailUrl: '/api/v1/agents/example%2Fsloppenheimer%2331',
            },
          ],
        }),
        // Nothing retained for this issue, so the retrying row stands in.
        agentDetail: (identifier) => Effect.succeed({ _tag: 'NoSession', identifier }),
      }
      yield* withServer(queued, async (url) => {
        const response = await fetch(
          `${url}/api/v1/${encodeURIComponent('example/sloppenheimer#31')}`,
        )
        expect(await response.json()).toMatchObject({
          status: 'retrying',
          // No attempt beyond the first has started yet.
          attempts: { restart_count: 0, current_retry_attempt: 0 },
          // The attempt that is queued is published here, where it belongs.
          retry: { attempt: 1, due_at: '2026-08-29T12:01:00.000Z', reason: 'turn failed' },
        })
      })
    }),
  )

  /*
   * `IssueIdentifier` is an unconstrained branded string and the port boundary is tracker-neutral,
   * so the SPEC resource must answer for an identifier a provider spells its own way. Deciding on
   * GitHub's behalf which shapes are addressable would make the resource unreachable for a tracker
   * whose identifiers carry no `#`.
   */
  it.live('resolves an identifier that is not shaped like a GitHub one', () =>
    Effect.gen(function* () {
      const jiraLike: OperatorBackend = {
        ...makeBackend(),
        snapshot: Effect.succeed({
          ...snapshot,
          running: [],
          handoffs: [
            {
              issueId: '7',
              identifier: 'GH-7',
              pullRequestUrl: 'https://example.test/pull/7',
              branchName: 'sloppenheimer/gh-7',
              state: 'awaiting_checks',
              headSha: null,
              reason: null,
              repairAttempts: 0,
              observedAt: '2026-08-29T12:00:00.000Z',
            },
          ],
        }),
        agentDetail: (identifier) => Effect.succeed({ _tag: 'Unknown', identifier }),
      }
      yield* withServer(jiraLike, async (url) => {
        const resolved = await fetch(`${url}/api/v1/${encodeURIComponent('GH-7')}`)
        expect(resolved.status).toBe(200)
        expect(await resolved.json()).toMatchObject({
          issue_identifier: 'GH-7',
          issue_id: '7',
          status: 'handoff',
          tracked: true,
        })

        // Still unknown is still 404 — the lookup decides, not the spelling.
        const missing = await fetch(`${url}/api/v1/${encodeURIComponent('GH-8')}`)
        expect(missing.status).toBe(404)
        expect(await missing.json()).toMatchObject({ error: { code: 'issue_not_found' } })

        // The link a successful response advertises must be one its own target accepts. The agent
        // route answers for this identifier on its own terms — no session ran for it — rather than
        // refusing to read it at all.
        const body = await jsonObjectBody(
          await fetch(`${url}/api/v1/${encodeURIComponent('GH-7')}`),
        )
        const published = body['detail_url']
        const detailUrl = typeof published === 'string' ? published : ''
        expect(detailUrl).toBe('/api/v1/agents/GH-7')
        const followed = await fetch(`${url}${detailUrl}`)
        expect(followed.status).toBe(404)
        expect(await followed.json()).toMatchObject({ error: { code: 'agent_not_found' } })
      })
    }),
  )

  /*
   * SPEC 13.7.2 puts the fixed routes and the per-issue resource in one namespace, so a GET of a
   * path a fixed GET route already spells is answered by that route instead. #220 decided to
   * document that as a known limit rather than move the resource under a prefix or escape the
   * names, and this pins what each shadowed one answers — and that the shadowing is two names
   * wide, since a route registered for another method leaves the GET below it reachable.
   */
  it.live('shadows an issue identifier spelled like a fixed v1 GET route, and only those', () =>
    Effect.gen(function* () {
      const handoff = (identifier: string): HandoffSnapshot => ({
        issueId: identifier,
        identifier,
        pullRequestUrl: `https://example.test/pull/${identifier}`,
        branchName: `sloppenheimer/${identifier}`,
        state: 'awaiting_checks',
        headSha: null,
        reason: null,
        repairAttempts: 0,
        observedAt: '2026-08-29T12:00:00.000Z',
      })
      const colliding: OperatorBackend = {
        ...makeBackend(),
        snapshot: Effect.succeed({
          ...snapshot,
          running: [],
          counts: { running: 0, retrying: 0, delivering: 0, completed: 0 },
          // Every one of these is an issue this host knows about, addressable or not.
          handoffs: ['state', 'backlog', 'refresh', 'agents', 'issues'].map(handoff),
        }),
        agentDetail: (identifier) => Effect.succeed({ _tag: 'Unknown', identifier }),
      }

      yield* withServer(colliding, async (url) => {
        // This is the link such an issue would advertise as `self`, and it is the fixed route.
        expect(issueDetailPath('state')).toBe('/api/v1/state')

        const shadowedState = await fetch(`${url}/api/v1/state`)
        expect(shadowedState.status).toBe(200)
        const stateBody = await jsonObjectBody(shadowedState)
        // The runtime state document, not the issue whose identifier is spelled that way.
        expect(stateBody).toMatchObject({ counts: { running: 0 } })
        expect(stateBody['issue_identifier']).toBeUndefined()

        const shadowedBacklog = await fetch(`${url}/api/v1/backlog`)
        expect(shadowedBacklog.status).toBe(200)
        const backlogBody = await jsonObjectBody(shadowedBacklog)
        // The backlog document, in the internal vocabulary its own consumer reads.
        expect(backlogBody).toMatchObject({ controlLabel: 'sloppenheimer' })
        expect(Array.isArray(backlogBody['nodes'])).toBe(true)
        expect(backlogBody['issue_identifier']).toBeUndefined()

        // The refresh route is POST, and the resource below it is GET, so the method tells them
        // apart and this identifier is not reserved at all: a GET reads the issue, and the SPEC's
        // own POST still refreshes.
        const readRefresh = await fetch(`${url}/api/v1/refresh`)
        expect(readRefresh.status).toBe(200)
        expect(await readRefresh.json()).toMatchObject({
          self: '/api/v1/refresh',
          issue_identifier: 'refresh',
          status: 'handoff',
        })
        const page = await (await fetch(url)).text()
        const token = /name="csrf-token" content="([^"]+)"/u.exec(page)?.[1] ?? ''
        const refreshed = await fetch(`${url}/api/v1/refresh`, {
          method: 'POST',
          headers: { 'X-Sloppenheimer-CSRF': token },
        })
        expect(refreshed.status).toBe(202)
        expect(await refreshed.json()).toMatchObject({ queued: true })

        // Two routes share that URI, so a method neither of them answers must name both rather than
        // reporting the documented refresh method as unavailable.
        const wrongOnShared = await fetch(`${url}/api/v1/refresh`, { method: 'PUT' })
        expect(wrongOnShared.status).toBe(405)
        expect(wrongOnShared.headers.get('allow')).toBe('GET, POST')
        expect(await wrongOnShared.json()).toMatchObject({
          error: { message: 'Use GET or POST for this endpoint' },
        })
        // A path the per-issue resource has to itself still names only its own method.
        const wrongOnIssue = await fetch(`${url}/api/v1/agents`, { method: 'PUT' })
        expect(wrongOnIssue.status).toBe(405)
        expect(wrongOnIssue.headers.get('allow')).toBe('GET')

        // The other two words the router uses are not reserved either: those routes carry a further
        // segment, so the wildcard still answers for an issue identified by the bare word.
        for (const identifier of ['agents', 'issues', 'refresh']) {
          const resolved = await fetch(`${url}/api/v1/${identifier}`)
          expect(resolved.status).toBe(200)
          expect(await resolved.json()).toMatchObject({
            self: `/api/v1/${identifier}`,
            issue_identifier: identifier,
            status: 'handoff',
          })
        }
      })
    }),
  )

  /*
   * The shadowed set is what the endpoint definitions make it, so it is derived from them here
   * rather than restated: a path assembled from a constant, a helper or a template literal shadows
   * an identifier exactly as a literal does and would be invisible to a guard that read the source.
   * A third shadowed name would arrive without anybody deciding to reserve one.
   */
  it('reserves no identifier beyond the two fixed v1 GET routes the API declares', (): void => {
    const registered = operatorRoutes.flatMap((route) => {
      // Neither a parameter nor a further segment can collide: an identifier is one segment, and
      // only a fixed one is spelled the same way twice. Nor can a route that answers some other
      // method: the per-issue resource is a GET, so only a route reachable by GET hides it.
      const reserved = /^\/api\/v1\/([^/:*]+)$/u.exec(route.path)?.[1]
      return reserved === undefined || route.method !== 'GET' ? [] : [reserved]
    })

    expect([...new Set(registered)].sort()).toEqual(['backlog', 'state'])
  })

  /*
   * The documents are encoded through the schemas the endpoints declare, so what reaches a reader
   * is what the contract describes rather than whatever the backend happened to be holding. A field
   * no endpoint declares is the observable half of that: it does not reach the wire.
   */
  it.live('publishes the document its endpoint declares, and nothing beside it', () =>
    Effect.gen(function* () {
      const held = {
        controlLabel: 'sloppenheimer',
        issues: [],
        nodes: [],
        edges: [],
        cycles: [],
        internalNote: 'not part of the published contract',
      }
      const backend: OperatorBackend = { ...makeBackend(), backlog: Effect.succeed(held) }

      yield* withServer(backend, async (url) => {
        const response = await fetch(`${url}/api/v1/backlog`)
        const body = await jsonObjectBody(response)

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
        expect(body).toMatchObject({ controlLabel: 'sloppenheimer', issues: [], nodes: [] })
        expect(body['internalNote']).toBeUndefined()
      })
    }),
  )

  /*
   * The description is generated from the same endpoint definitions the server routes and encodes
   * against, and it is served outside the versioned namespace: a name under `/api/v1/` would shadow
   * an issue identifier spelled the same way, and that namespace reserves exactly two.
   */
  it.live('serves an OpenAPI description generated from its own endpoint definitions', () =>
    withServer(makeBackend(), async (url) => {
      const response = await fetch(`${url}/openapi.json`)

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
      // What is served is the generated description itself, rather than something reshaped on the
      // way out; what that description says is pinned against the endpoint definitions in
      // `test/operator/api-contract.test.ts`.
      expect(await response.json()).toEqual(operatorOpenApiDocument())
      // Serving it reserves no identifier, because it is not in the versioned namespace at all.
      expect(operatorRoutes.some((route) => route.path === '/openapi.json')).toBe(false)
    }),
  )

  it.live('acknowledges a refresh with what the request amounted to', () =>
    withServer(makeBackend(), async (url) => {
      const rejected = await fetch(`${url}/api/v1/refresh`, { method: 'POST' })
      expect(rejected.status).toBe(403)
      expect(await rejected.json()).toMatchObject({ error: { code: 'invalid_csrf_token' } })

      const page = await (await fetch(url)).text()
      const token = /name="csrf-token" content="([^"]+)"/u.exec(page)?.[1] ?? ''
      const accepted = await fetch(`${url}/api/v1/refresh`, {
        method: 'POST',
        headers: { 'X-Sloppenheimer-CSRF': token },
      })

      expect(accepted.status).toBe(202)
      expect(await accepted.json()).toEqual({
        queued: true,
        coalesced: false,
        requested_at: '2026-08-29T12:00:00.000Z',
        operations: ['issue_reconciliation', 'dispatch'],
      })
    }),
  )

  it.live('requires its page token before changing issue eligibility', () =>
    Effect.gen(function* () {
      const setIssueEnabled = vi.fn()
      yield* withServer(makeBackend(setIssueEnabled), async (url) => {
        const rejected = await fetch(`${url}/api/v1/issues/17/pause`, { method: 'POST' })
        expect(rejected.status).toBe(403)

        // A token that arrived and does not match is refused on the same terms as one that never
        // arrived at all.
        const wrongToken = await fetch(`${url}/api/v1/issues/17/start`, {
          method: 'POST',
          headers: { 'X-Sloppenheimer-CSRF': 'not-the-token-this-process-minted' },
        })
        expect(wrongToken.status).toBe(403)
        expect(await wrongToken.json()).toMatchObject({ error: { code: 'invalid_csrf_token' } })

        const page = await (await fetch(url)).text()
        const token = /name="csrf-token" content="([^"]+)"/u.exec(page)?.[1]
        expect(token).toBeDefined()
        const accepted = await fetch(`${url}/api/v1/issues/17/pause`, {
          method: 'POST',
          headers: { 'X-Sloppenheimer-CSRF': token ?? '' },
        })
        const started = await fetch(`${url}/api/v1/issues/17/start`, {
          method: 'POST',
          headers: { 'X-Sloppenheimer-CSRF': token ?? '' },
        })

        expect(accepted.status).toBe(202)
        expect(started.status).toBe(202)
        expect(setIssueEnabled).toHaveBeenCalledWith(17, false)
        expect(setIssueEnabled).toHaveBeenCalledWith(17, true)

        // The token is what the endpoint declares, and an issue number this API cannot address
        // names no resource whether or not one came with the request.
        const unaddressable = await fetch(`${url}/api/v1/issues/not-a-number/start`, {
          method: 'POST',
          headers: { 'X-Sloppenheimer-CSRF': token ?? '' },
        })
        expect(unaddressable.status).toBe(404)

        // A parameter is judged as the router will hand it to the handler, which is decoded. An
        // escaped spelling of a number this API can address still names that issue.
        const escaped = await fetch(`${url}/api/v1/issues/%31%37/pause`, {
          method: 'POST',
          headers: { 'X-Sloppenheimer-CSRF': token ?? '' },
        })
        expect(escaped.status).toBe(202)
        expect(await escaped.json()).toMatchObject({ issueNumber: 17, enabled: false })
      })
    }),
  )

  it.live('returns explicit 404 and 405 responses', () =>
    withServer(makeBackend(), async (url) => {
      const missing = await fetch(`${url}/missing`)
      const wrongMethod = await fetch(`${url}/api/v1/state`, { method: 'POST' })
      const invalidAction = await fetch(`${url}/api/v1/issues/not-a-number/start`, {
        method: 'POST',
      })

      expect(missing.status).toBe(404)
      expect(wrongMethod.status).toBe(405)
      expect(wrongMethod.headers.get('allow')).toBe('GET')
      expect(invalidAction.status).toBe(404)

      // A `405` advertises what a URI serves, so it is only ever the answer for a URI that names
      // something. An issue number this API cannot address names no resource on any method, and
      // reporting the eligibility POST for it would say a resource exists that does not.
      const readableAction = await fetch(`${url}/api/v1/issues/17/start`)
      const unaddressableAction = await fetch(`${url}/api/v1/issues/not-a-number/start`)

      expect(readableAction.status).toBe(405)
      expect(readableAction.headers.get('allow')).toBe('POST')
      expect(unaddressableAction.status).toBe(404)
      expect(await unaddressableAction.json()).toMatchObject({ error: { code: 'not_found' } })
    }),
  )

  /*
   * A URI whose parameter carries a malformed escape names nothing: there is no reading of it to
   * route on, and the router will not match one. It has to be refused as unaddressable rather than
   * dispatched — a request the API cannot route is a `404` like any other URI that names nothing,
   * not a failure to report.
   */
  it.live('refuses a parameter that has no reading rather than dispatching it', () =>
    withServer(makeBackend(), async (url) => {
      const refusals = await Promise.all(
        [
          `${url}/api/v1/%`,
          `${url}/api/v1/%zz`,
          `${url}/api/v1/%E0%A4%A`,
          `${url}/api/v1/agents/%`,
          `${url}/api/v1/issues/%/start`,
        ].map(async (target) => {
          const response = await fetch(target, {
            method: target.endsWith('/start') ? 'POST' : 'GET',
          })
          const body = await jsonObjectBody(response)
          return { status: response.status, body }
        }),
      )

      for (const refusal of refusals) {
        expect(refusal.status).toBe(404)
        expect(refusal.body).toMatchObject({ error: { code: 'not_found' } })
      }

      // An escape that does have a reading is addressed on that reading, which is how every
      // identifier this API publishes a link for reaches its resource.
      const encoded = await fetch(`${url}/api/v1/${encodeURIComponent('example/sloppenheimer#17')}`)
      expect(encoded.status).toBe(200)
    }),
  )

  it.live('rejects non-loopback host headers', () =>
    withServer(makeBackend(), async (url) => {
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
    }),
  )

  it.live('sanitizes typed backend failures as versioned 502 responses', () =>
    Effect.gen(function* () {
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

      yield* withServer(backend, async (url) => {
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
    }),
  )

  it.live('sanitizes unexpected defects as versioned 500 responses', () =>
    Effect.gen(function* () {
      const backend: OperatorBackend = {
        ...makeBackend(),
        snapshot: Effect.die(new Error('sensitive defect detail')),
      }

      yield* withServer(backend, async (url) => {
        const response = await fetch(`${url}/api/v1/state`)
        const body = await response.text()

        expect(response.status).toBe(500)
        expect(JSON.parse(body)).toEqual({
          version: 'v1',
          error: { code: 'internal_error', message: 'The request could not be completed' },
        })
        expect(body).not.toContain('sensitive defect detail')
      })
    }),
  )

  it.live('represents listen failures as ServerError', () => {
    const occupied = createServer()

    return Effect.gen(function* () {
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            occupied.once('error', reject)
            occupied.listen(0, '127.0.0.1', resolve)
          }),
      )
      const address = occupied.address()
      if (address === null || typeof address === 'string') {
        throw new Error('test server did not expose a TCP address')
      }

      const failure = yield* Effect.flip(
        Effect.scoped(startOperatorServer(address.port, makeBackend())),
      )

      expect(failure._tag).toBe('ServerError')
      expect(failure.category).toBe('listen_failed')
    }).pipe(
      Effect.ensuring(
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              occupied.close((error) => (error === undefined ? resolve() : reject(error)))
            }),
        ),
      ),
    )
  })

  it.live('stops accepting connections when its scope closes', () =>
    Effect.gen(function* () {
      let url = ''
      yield* Effect.scoped(
        Effect.map(startOperatorServer(0, makeBackend()), (server) => {
          url = server.url
        }),
      )

      yield* Effect.promise(() => expect(fetch(url)).rejects.toThrow())
    }),
  )
})
