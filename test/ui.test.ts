import { Window, type HTMLButtonElement, type HTMLInputElement } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { issueId, issueIdentifier } from '../src/domain.js'
import type { OrchestratorSnapshot } from '../src/orchestrator.js'
import {
  buildAgentDetail,
  timelineCategories,
  createAgentDetailRecord,
  recordAgentEvent,
  recordHandoff,
  recordRetryScheduled,
  type AgentDetailRecord,
  type AgentDetailSnapshot,
} from '../src/telemetry.js'
import { appJavaScript, appTemplate } from '../src/ui-assets.js'

const runningIdentifier = 'example/symphony#17'
const retryingIdentifier = 'example/symphony#18'

const snapshot: OrchestratorSnapshot = {
  generatedAt: '2026-08-30T12:00:00.000Z',
  workflowPath: '/tmp/WORKFLOW.md',
  effectiveWorkflow: { fingerprint: 'ui', loadedAt: '2026-08-30T11:00:00.000Z' },
  workflowReloadError: null,
  pollingIntervalMs: 10_000,
  maxConcurrentAgents: 2,
  counts: { running: 1, retrying: 1, completed: 0 },
  pausedIssueNumbers: [],
  handoffs: [],
  running: [
    {
      issueId: issueId('17'),
      identifier: runningIdentifier,
      title: 'Operator console',
      url: 'https://example.test/issues/17',
      attempt: null,
      startedAt: '2026-08-30T11:59:00.000Z',
      lastEventAt: '2026-08-30T11:59:30.000Z',
      lastEvent: 'item/completed',
      lastMessage: null,
      processId: 42,
      threadId: 'thread-1',
      turnId: 'turn-1',
      sessionId: 'thread-1',
      turnCount: 1,
      tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      lastReportedTokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      workerHost: 'local',
      detailUrl: '/api/v1/agents/example%2Fsymphony%2317',
    },
  ],
  retrying: [
    {
      issueId: issueId('18'),
      identifier: retryingIdentifier,
      title: 'Flaky dependency',
      url: 'https://example.test/issues/18',
      attempt: 1,
      dueAt: '2026-08-30T12:00:15.000Z',
      error: 'turn failed',
      workerHost: 'local',
      detailUrl: '/api/v1/agents/example%2Fsymphony%2318',
    },
  ],
  totals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 60 },
  rateLimits: null,
}

const backlog = {
  controlLabel: 'symphony',
  issues: [
    {
      number: 17,
      identifier: runningIdentifier,
      title: 'Operator console',
      url: 'https://example.test/issues/17',
      labels: ['symphony'],
      priority: 1,
      createdAt: null,
      enabled: true,
      state: 'open',
      blockedBy: [],
      readiness: 'ready',
      reason: null,
    },
  ],
  nodes: [
    {
      identifier: runningIdentifier,
      number: 17,
      title: 'Operator console',
      url: 'https://example.test/issues/17',
      state: 'open',
      readiness: 'ready',
      reason: null,
      actionable: true,
    },
  ],
  edges: [],
  cycles: [],
}

const populated = (withHandoff: boolean): AgentDetailRecord => {
  // Fixtures are anchored to the moment the test runs, so live countdowns are meaningful.
  const base = Date.now() - 60_000
  const record = createAgentDetailRecord({
    issueId: issueId('17'),
    identifier: issueIdentifier(runningIdentifier),
    title: 'Operator console',
    url: 'https://example.test/issues/17',
    attempt: null,
    startedAt: new Date(base),
    workspacePathKey: 'example_symphony_17',
    expectedBranch: 'symphony/issue-17',
    dispatchLabels: ['symphony'],
  })
  recordAgentEvent(record, {
    event: 'item/completed',
    timestamp: new Date(base + 10_000),
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
      kind: 'message',
      role: 'assistant',
      text: 'Working on the console',
      truncated: false,
    },
  })
  recordAgentEvent(record, {
    event: 'item/started',
    timestamp: new Date(base + 20_000),
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
  if (!withHandoff) {
    return record
  }
  recordHandoff(record, new Date(base + 30_000), {
    step: 'pull_request',
    status: 'observed',
    message: 'Opened a pull request for the completed work',
    pullRequest: {
      status: 'created',
      number: 61,
      url: 'https://example.test/pull/61',
      state: 'awaiting_checks',
    },
    outcome: 'pull_request_open',
  })
  return record
}

const runningDetail = (withHandoff = true, stallTimeoutMs = 300_000): AgentDetailSnapshot =>
  buildAgentDetail(populated(withHandoff), {
    self: '/api/v1/agents/example%2Fsymphony%2317',
    now: new Date(),
    status: 'running',
    stallTimeoutMs,
    workerHost: 'local',
    branch: 'symphony/issue-17',
    retry: null,
  })

const retryingDetail = (): AgentDetailSnapshot => {
  const at = new Date()
  const record = createAgentDetailRecord({
    issueId: issueId('18'),
    identifier: issueIdentifier(retryingIdentifier),
    title: 'Flaky dependency',
    url: 'https://example.test/issues/18',
    attempt: 0,
    startedAt: new Date(at.getTime() - 30_000),
    workspacePathKey: 'example_symphony_18',
    expectedBranch: 'symphony/issue-18',
    dispatchLabels: ['symphony'],
  })
  const dueAt = new Date(at.getTime() + 15_000)
  recordRetryScheduled(record, at, 1, dueAt, 'turn failed')
  return buildAgentDetail(record, {
    self: '/api/v1/agents/example%2Fsymphony%2318',
    now: at,
    status: 'retrying',
    stallTimeoutMs: 60_000,
    workerHost: 'local',
    branch: 'symphony/issue-18',
    retry: { attempt: 1, dueAt, reason: 'turn failed' },
  })
}

type DetailResponse = Readonly<{ status: number; body: unknown }>
type Interval = Readonly<{ handler: () => void; ms: number }>

type ConsoleScript = (
  window: Window,
  document: Window['document'],
  navigator: unknown,
  fetch: (path: string, options?: unknown) => Promise<Response>,
  setInterval: (handler: () => void, ms: number) => number,
) => void

let page: Window
let intervals: Interval[]
let requestLog: string[]
let detailResponses: Map<string, DetailResponse>
let detailPending: boolean

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let serveOverride: ((path: string) => Promise<Response> | null) | null = null

const serve = async (path: string): Promise<Response> => {
  requestLog.push(path)
  const overridden = serveOverride?.(path) ?? null
  if (overridden !== null) {
    return overridden
  }
  if (path === '/api/v1/state') {
    return jsonResponse(200, snapshot)
  }
  if (path === '/api/v1/backlog') {
    return jsonResponse(200, backlog)
  }
  if (path.startsWith('/api/v1/agents/')) {
    if (detailPending) {
      return new Promise<Response>(() => undefined)
    }
    const identifier = decodeURIComponent(path.slice('/api/v1/agents/'.length))
    const configured = detailResponses.get(identifier)
    return configured === undefined
      ? jsonResponse(404, {
          version: 'v1',
          error: { code: 'agent_not_found', message: 'No agent has that identifier' },
        })
      : jsonResponse(configured.status, configured.body)
  }
  return jsonResponse(404, { version: 'v1', error: { code: 'not_found', message: 'missing' } })
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}

/** Fires every interval the console registered at the given period. */
const tick = async (ms: number): Promise<void> => {
  for (const interval of intervals) {
    if (interval.ms === ms) {
      interval.handler()
    }
  }
  await flush()
}

const boot = async (hash = ''): Promise<void> => {
  page = new Window({ url: `http://127.0.0.1:7777/${hash}` })
  const body = /<body>([\s\S]*)<\/body>/u.exec(appTemplate)?.[1] ?? ''
  page.document.head.innerHTML = '<meta name="csrf-token" content="ui-test-token">'
  page.document.body.innerHTML = body
  // The console ships as one classic script, so evaluating that exact source is the only way to
  // exercise what an operator gets. Its globals are supplied explicitly, which keeps the timers
  // deterministic and the transport under the test's control.
  // Running the console's exact published source is the point of this suite.
  // oxlint-disable-next-line typescript/no-implied-eval
  const script = new Function(
    'window',
    'document',
    'navigator',
    'fetch',
    'setInterval',
    appJavaScript,
  ) as ConsoleScript
  script(
    page,
    page.document,
    { clipboard: { writeText: (): Promise<void> => Promise.resolve() } },
    serve,
    (handler, ms) => {
      intervals.push({ handler, ms })
      return intervals.length
    },
  )
  await flush()
}

const query = (selector: string): HTMLButtonElement => {
  const found = page.document.querySelector(selector)
  if (found === null) {
    throw new Error(`missing element: ${selector}`)
  }
  return found as unknown as HTMLButtonElement
}

const cardFor = (identifier: string): HTMLButtonElement => {
  const cards = [...page.document.querySelectorAll('.work-card')]
  const found = cards.find((card) => card.getAttribute('data-identifier') === identifier)
  if (found === undefined) {
    throw new Error(`no work card for ${identifier}`)
  }
  return found as unknown as HTMLButtonElement
}

const textOf = (selector: string): string =>
  page.document.querySelector(selector)?.textContent?.trim() ?? ''

const openRunning = async (): Promise<HTMLButtonElement> => {
  const card = cardFor(runningIdentifier)
  card.click()
  await flush()
  return card
}

beforeEach((): void => {
  intervals = []
  requestLog = []
  detailPending = false
  serveOverride = null
  detailResponses = new Map([
    [runningIdentifier, { status: 200, body: { version: 'v1', detail: runningDetail() } }],
    [retryingIdentifier, { status: 200, body: { version: 'v1', detail: retryingDetail() } }],
  ])
})

afterEach(async (): Promise<void> => {
  await page.happyDOM.close()
})

describe('operator console agent detail', (): void => {
  it('offers a filter for every normalized event category', async (): Promise<void> => {
    await boot()

    const offered = [...page.document.querySelectorAll('#detail-filters input')].map((input) =>
      input.getAttribute('value'),
    )
    expect(offered).toEqual([...timelineCategories])
  })

  it('opens an inspection panel from a running agent and deep links it', async (): Promise<void> => {
    await boot()
    const card = cardFor(runningIdentifier)
    expect(card.getAttribute('aria-expanded')).toBe('false')
    expect(card.getAttribute('aria-controls')).toBe('agent-detail')

    card.click()
    await flush()

    expect(query('#agent-detail').hidden).toBe(false)
    expect(card.getAttribute('aria-expanded')).toBe('true')
    expect(page.location.hash).toBe('#/agents/example%2Fsymphony%2317')
    expect(page.document.activeElement?.id).toBe('detail-title')
    expect(textOf('#detail-title')).toBe('Operator console')
    expect(textOf('#detail-phase')).toContain('running')
    expect(textOf('#detail-facts')).toContain('thread-1')
    expect(textOf('#detail-facts')).toContain('example_symphony_17')
    expect(textOf('#detail-timeline')).toContain('Working on the console')
    expect(textOf('#detail-timeline')).toContain('Command pnpm')
  })

  it('shows the handoff pull request link and the expected branch', async (): Promise<void> => {
    await boot()
    await openRunning()

    const link = page.document.querySelector('#detail-facts a[href*="pull"]')
    expect(link?.getAttribute('href')).toBe('https://example.test/pull/61')
    expect(textOf('#detail-facts')).toContain('symphony/issue-17')
    expect(textOf('#detail-timeline')).toContain('Handoff pull request')
  })

  it('shows a closed-without-merge handoff as a clear terminal status', async (): Promise<void> => {
    serveOverride = (path): Promise<Response> | null =>
      path === '/api/v1/state'
        ? Promise.resolve(
            jsonResponse(200, {
              ...snapshot,
              handoffs: [
                {
                  issueId: '75',
                  identifier: 'example/symphony#75',
                  pullRequestUrl: 'https://example.test/pull/50',
                  branchName: 'symphony/issue-75',
                  state: 'closed_without_merge',
                  headSha: 'closed-head',
                  reason: 'The pull request was closed without being merged',
                  repairAttempts: 0,
                  observedAt: '2026-08-30T12:00:00.000Z',
                },
              ],
            }),
          )
        : null

    await boot()

    expect(textOf('#handoff-list')).toContain('Closed without merge')
    expect(textOf('#handoff-list')).toContain('The pull request was closed without being merged')
  })

  it('restores an inspection from a deep link on load', async (): Promise<void> => {
    await boot(`#/agents/${encodeURIComponent(runningIdentifier)}`)

    expect(query('#agent-detail').hidden).toBe(false)
    expect(requestLog).toContain('/api/v1/agents/example%2Fsymphony%2317')
    expect(textOf('#detail-title')).toBe('Operator console')
  })

  it('filters the timeline by event category', async (): Promise<void> => {
    await boot()
    await openRunning()
    expect(textOf('#detail-timeline')).toContain('Command pnpm')

    const commandFilter = page.document.querySelector(
      '#detail-filters input[value="command"]',
    ) as unknown as HTMLInputElement
    expect(commandFilter.checked).toBe(true)
    commandFilter.checked = false
    commandFilter.dispatchEvent(new page.Event('change'))

    expect(textOf('#detail-timeline')).not.toContain('Command pnpm')
    expect(textOf('#detail-timeline')).toContain('Working on the console')

    for (const input of page.document.querySelectorAll('#detail-filters input')) {
      const control = input as unknown as HTMLInputElement
      control.checked = false
      control.dispatchEvent(new page.Event('change'))
    }
    expect(textOf('#detail-timeline')).toContain('No events match the selected filters')
  })

  it('explains why an agent is retrying and when the next attempt is due', async (): Promise<void> => {
    await boot()
    cardFor(retryingIdentifier).click()
    await flush()

    const status = textOf('#detail-status')
    expect(status).toContain('Retrying because turn failed')
    expect(status).toContain('Attempt 1 starts in 15s')
    expect(query('#agent-detail').getAttribute('data-state')).toBe('retrying')
    expect(textOf('#detail-timeline')).toContain('Retry attempt 1')
  })

  it('warns about a stall the published snapshot has not yet observed', async (): Promise<void> => {
    detailResponses.set(runningIdentifier, {
      status: 200,
      body: { version: 'v1', detail: runningDetail(false) },
    })
    await boot()
    await openRunning()
    expect(textOf('#detail-status')).toContain('Considered stalled in')

    // The deadline has passed since the snapshot was published: the console must decide from the
    // absolute deadline it already holds instead of waiting for a later fetch to say so.
    const published = runningDetail(false)
    detailResponses.set(runningIdentifier, {
      status: 200,
      body: {
        version: 'v1',
        detail: {
          ...published,
          activity: {
            ...published.activity,
            stalled: false,
            stallDeadline: new Date(Date.now() - 1_000).toISOString(),
            stallCountdownMs: 5_000,
          },
        },
      },
    })
    await tick(2_000)
    const requests = requestLog.filter((path) => path.startsWith('/api/v1/agents/')).length
    await tick(1_000)

    expect(textOf('#detail-status')).toContain('Stalled')
    expect(query('#agent-detail').getAttribute('data-state')).toBe('stalled')
    // The one-second refresh recomputes the warning without asking the orchestrator again.
    expect(requestLog.filter((path) => path.startsWith('/api/v1/agents/')).length).toBe(requests)
  })

  it('ignores a stale detail response that finishes after a newer one', async (): Promise<void> => {
    // The first request is left hanging and released only after a later one has already answered.
    let releaseFirst = (_response: Response): void => undefined
    let served = 0
    const stale = {
      ...runningDetail(false),
      phase: {
        phase: 'starting' as const,
        operation: 'Stale operation',
        since: new Date().toISOString(),
      },
    }
    const fresh = {
      ...runningDetail(false),
      phase: {
        phase: 'editing' as const,
        operation: 'Fresh operation',
        since: new Date().toISOString(),
      },
    }
    const originalServe = serveOverride
    serveOverride = (path: string): Promise<Response> | null => {
      if (!path.startsWith('/api/v1/agents/')) {
        return null
      }
      served += 1
      if (served === 1) {
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve
        })
      }
      return Promise.resolve(jsonResponse(200, { version: 'v1', detail: fresh }))
    }
    try {
      await boot()
      await openRunning()
      await tick(2_000)
      expect(textOf('#detail-operation')).toBe('Fresh operation')

      releaseFirst(jsonResponse(200, { version: 'v1', detail: stale }))
      await flush()

      expect(textOf('#detail-operation')).toBe('Fresh operation')
    } finally {
      serveOverride = originalServe
    }
  })

  it('recovers after a failed detail request', async (): Promise<void> => {
    detailResponses.set(runningIdentifier, {
      status: 503,
      body: {
        version: 'v1',
        error: {
          code: 'agent_detail_unavailable',
          message: 'The agent session is still starting',
        },
      },
    })
    await boot()
    await openRunning()

    expect(textOf('#detail-status')).toContain('The agent session is still starting')
    expect(query('#agent-detail').getAttribute('data-state')).toBe('error')

    detailResponses.set(runningIdentifier, {
      status: 200,
      body: { version: 'v1', detail: runningDetail() },
    })
    await tick(2_000)

    expect(textOf('#detail-status')).not.toContain('still starting')
    expect(textOf('#detail-timeline')).toContain('Command pnpm')
  })

  it('keeps polling the dashboard while a detail request is outstanding', async (): Promise<void> => {
    await boot()
    detailPending = true
    await openRunning()
    const before = requestLog.filter((path) => path === '/api/v1/state').length

    await tick(2_000)
    await tick(3_000)

    expect(requestLog.filter((path) => path === '/api/v1/state').length).toBeGreaterThan(before)
  })

  it('closes on Escape and returns focus to the card that opened it', async (): Promise<void> => {
    await boot()
    const card = await openRunning()

    page.document.dispatchEvent(new page.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(query('#agent-detail').hidden).toBe(true)
    expect(page.location.hash).not.toContain('/agents/')
    expect(card.getAttribute('aria-expanded')).toBe('false')
    expect(page.document.activeElement?.getAttribute('data-identifier')).toBe(runningIdentifier)
  })
})
