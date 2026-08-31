import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HTMLInputElement } from 'happy-dom'

import { issueId, issueIdentifier } from '@symphony/core/domain/domain.js'
import {
  buildAgentDetail,
  timelineCategories,
  createAgentDetailRecord,
  recordAgentEvent,
  recordHandoff,
  recordRetryScheduled,
  type AgentDetailRecord,
  type AgentDetailSnapshot,
} from '@symphony/core/telemetry.js'
import {
  bootConsole,
  jsonResponse,
  type ConsolePage,
  type DetailResponse,
} from '../harness/operator-console.js'
import {
  consoleBacklog,
  consoleState,
  retryingIdentifier,
  runningIdentifier,
} from '../harness/console-fixtures.js'

const populated = (withHandoff: boolean): AgentDetailRecord => {
  // Fixtures are anchored to the moment the test runs, so live countdowns are meaningful.
  const base = Date.now() - 60_000
  let record = createAgentDetailRecord({
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
  record = recordAgentEvent(record, {
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
    lifecycle: null,
    payload: {
      kind: 'message',
      role: 'assistant',
      text: 'Working on the console',
      truncated: false,
    },
  })
  record = recordAgentEvent(record, {
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
  if (!withHandoff) {
    return record
  }
  record = recordHandoff(record, new Date(base + 30_000), {
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

const runningDetail = (
  withHandoff = true,
  stallTimeoutMs = 300_000,
  handoffEnabled = true,
): AgentDetailSnapshot =>
  buildAgentDetail(populated(withHandoff), {
    self: '/api/v1/agents/example%2Fsymphony%2317',
    now: new Date(),
    status: 'running',
    stallTimeoutMs,
    workerHost: 'local',
    handoffEnabled,
    branch: 'symphony/issue-17',
    retry: null,
  })

const retryingDetail = (): AgentDetailSnapshot => {
  const at = new Date()
  let record = createAgentDetailRecord({
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
  record = recordRetryScheduled(record, at, 1, dueAt, 'turn failed')
  return buildAgentDetail(record, {
    self: '/api/v1/agents/example%2Fsymphony%2318',
    now: at,
    status: 'retrying',
    stallTimeoutMs: 60_000,
    workerHost: 'local',
    handoffEnabled: true,
    branch: 'symphony/issue-18',
    retry: { attempt: 1, dueAt, reason: 'turn failed' },
  })
}

/** Mirrors the overlay's own focusable-control selector. */
const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

let page: ConsolePage
let details: Map<string, DetailResponse>
let detailPending: boolean
let serveOverride: ((path: string) => Promise<Response> | null) | null

const boot = async (
  options: Readonly<{ hash?: string; width?: number }> = {},
): Promise<ConsolePage> => {
  page = await bootConsole({
    ...options,
    state: consoleState(),
    backlog: consoleBacklog(),
    details,
    detailPending: () => detailPending,
    serve: (path) => serveOverride?.(path) ?? null,
  })
  return page
}

const openAgent = async (identifier: string): Promise<{ click: () => void }> => {
  const trigger = page.card(identifier).querySelector('.inspect') as unknown as {
    click: () => void
  }
  trigger.click()
  await page.flush()
  return trigger
}

beforeEach((): void => {
  detailPending = false
  serveOverride = null
  details = new Map([
    [runningIdentifier, { status: 200, body: { version: 'v1', detail: runningDetail() } }],
    [retryingIdentifier, { status: 200, body: { version: 'v1', detail: retryingDetail() } }],
  ])
})

afterEach(async (): Promise<void> => {
  await page.close()
})

describe('operator console agent detail', (): void => {
  it('leads with the current operation and health before any identifier', async (): Promise<void> => {
    await boot()
    await openAgent(runningIdentifier)

    expect(page.query('#agent-detail').hidden).toBe(false)
    expect(page.text('#detail-title')).toBe('Operator console')
    const summary = page.text('#detail-summary')
    expect(summary).toContain('Current operation')
    expect(summary).toContain('Elapsed')
    expect(summary).toContain('Last activity')
    expect(summary).toContain('Workspace changes')
    expect(summary).toContain('Handoff progress')
    expect(page.query('#detail-summary .chip')?.textContent).toBe('Healthy')
    // Identity facts are still available, but they are not what the panel opens with.
    expect(summary).not.toContain('thread-1')
    expect(page.text('#detail-outcome')).toContain('pull request')
  })

  it('does not promise a pull request on a host that composes no code review', async (): Promise<void> => {
    details.set(runningIdentifier, {
      status: 200,
      body: { version: 'v1', detail: runningDetail(false, 300_000, false) },
    })
    await boot()
    await openAgent(runningIdentifier)

    const outcome = page.text('#detail-outcome')
    expect(outcome).toContain('Handoff is disabled on this host')
    expect(outcome).not.toContain('pull request for review')
  })

  it('keeps process and protocol identity in a Diagnostics disclosure', async (): Promise<void> => {
    await boot()
    await openAgent(runningIdentifier)

    const diagnostics = page.text('#detail-diagnostics')
    expect(diagnostics).toContain('thread-1')
    expect(diagnostics).toContain('42')
    expect(diagnostics).toContain('Rate limits')
    expect(diagnostics).toContain('example_symphony_17')
    expect(page.query('.diagnostics summary').textContent).toBe('Diagnostics')
    // The disclosure is closed until the operator asks for it.
    expect(page.query('.diagnostics').getAttribute('open')).toBeNull()
  })

  it('offers three timeline presets and keeps the full category filters available', async (): Promise<void> => {
    await boot()
    await openAgent(runningIdentifier)

    expect(page.all('#detail-presets button').map((button) => button.textContent)).toEqual([
      'Summary',
      'Errors and retries',
      'Everything',
    ])
    const offered = page.all('#detail-filters input').map((input) => input.getAttribute('value'))
    expect(offered).toEqual([...timelineCategories])
    expect(page.query('.advanced-filters summary').textContent).toBe('Advanced filters')
  })

  it('excludes protocol noise from Summary while keeping commands and handoffs', async (): Promise<void> => {
    await boot()
    await openAgent(runningIdentifier)

    expect(
      page.query('#detail-presets button[data-preset="summary"]').getAttribute('aria-pressed'),
    ).toBe('true')
    const summary = page.text('#detail-timeline')
    expect(summary).toContain('Command pnpm')
    expect(summary).toContain('Handoff pull request')
    expect(summary).not.toContain('Working on the console')

    page.query('#detail-presets button[data-preset="everything"]').click()
    await page.flush()
    expect(page.text('#detail-timeline')).toContain('Working on the console')
  })

  it('narrows to failures and retries on request', async (): Promise<void> => {
    await boot()
    await openAgent(retryingIdentifier)

    page.query('#detail-presets button[data-preset="failures"]').click()
    await page.flush()

    expect(page.text('#detail-timeline')).toContain('Retry attempt 1')
    expect(page.text('#detail-timeline')).not.toContain('Command pnpm')
  })

  it('lets an advanced filter override the active preset', async (): Promise<void> => {
    await boot()
    await openAgent(runningIdentifier)

    const command = page.query<HTMLInputElement>('#detail-filters input[value="command"]')
    expect(command.checked).toBe(true)
    command.checked = false
    command.dispatchEvent(new page.window.Event('change'))
    await page.flush()

    expect(page.text('#detail-timeline')).not.toContain('Command pnpm')
    expect(
      page.query('#detail-presets button[data-preset="summary"]').getAttribute('aria-pressed'),
    ).toBe('false')

    for (const input of page.all('#detail-filters input')) {
      const control = input as unknown as HTMLInputElement
      control.checked = false
      control.dispatchEvent(new page.window.Event('change'))
    }
    expect(page.text('#detail-timeline')).toContain('No events match the selected filters')
  })

  it('presents as a modal dialog and closes on the scrim as well as Escape', async (): Promise<void> => {
    await boot()
    const trigger = await openAgent(runningIdentifier)

    const dialog = page.query('#agent-detail')
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('detail-title')
    expect(page.window.document.body.classList.contains('detail-open')).toBe(true)

    page.query('#detail-scrim').click()
    await page.flush()

    expect(dialog.hidden).toBe(true)
    expect(page.window.document.body.classList.contains('detail-open')).toBe(false)
    expect(page.window.document.activeElement).toBe(trigger)
  })

  it('keeps Tab inside the modal instead of letting it reach the page behind', async (): Promise<void> => {
    await boot()
    await openAgent(runningIdentifier)

    // The same reachability rule the overlay applies: a control is in the cycle unless a `hidden`
    // ancestor or a closed disclosure it is not the summary of puts it out of reach.
    const reachable = [...page.query('#agent-detail').querySelectorAll(focusableSelector)].filter(
      (node) =>
        node.tagName === 'SUMMARY' ||
        node.closest('details') === null ||
        node.closest('details')?.hasAttribute('open') === true,
    )
    expect(reachable.length).toBeGreaterThan(2)
    const first = reachable[0] as unknown as { focus: () => void }
    const last = reachable[reachable.length - 1] as unknown as { focus: () => void }

    last.focus()
    page.window.document.dispatchEvent(
      new page.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    )
    expect(page.window.document.activeElement).toBe(reachable[0])

    first.focus()
    page.window.document.dispatchEvent(
      new page.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    )
    expect(page.window.document.activeElement).toBe(reachable[reachable.length - 1])
  })

  it('pulls focus back into the modal when it has escaped', async (): Promise<void> => {
    await boot()
    await openAgent(runningIdentifier)

    page.query('#refresh').focus()
    page.window.document.dispatchEvent(
      new page.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    )

    expect(page.query('#agent-detail').contains(page.window.document.activeElement)).toBe(true)
  })

  it('uses the same overlay on a phone, leaving the queue where it was', async (): Promise<void> => {
    await boot({ width: 390 })
    const before = page.identifiers('#progress-list .work-card')
    await openAgent(runningIdentifier)

    expect(page.query('#agent-detail').hidden).toBe(false)
    expect(page.query('#agent-detail').getAttribute('aria-modal')).toBe('true')
    expect(page.identifiers('#progress-list .work-card')).toEqual(before)
  })

  it('deep links the open agent and restores it on load', async (): Promise<void> => {
    await boot()
    await openAgent(runningIdentifier)
    expect(page.window.location.hash).toBe('#/agents/example%2Fsymphony%2317')

    await page.close()
    await boot({ hash: '#/agents/example%2Fsymphony%2317' })

    expect(page.query('#agent-detail').hidden).toBe(false)
    expect(page.requestLog).toContain('/api/v1/agents/example%2Fsymphony%2317')
    expect(page.text('#detail-title')).toBe('Operator console')
  })

  it('explains why an agent is retrying and when the next attempt is due', async (): Promise<void> => {
    await boot()
    await openAgent(retryingIdentifier)

    const status = page.text('#detail-status')
    expect(status).toContain('Retrying because turn failed')
    expect(status).toContain('Attempt 1 starts in 15s')
    expect(page.query('#agent-detail').getAttribute('data-state')).toBe('retrying')
    expect(page.text('#detail-outcome')).toContain('next attempt')
  })

  it('warns about a stall the published snapshot has not yet observed', async (): Promise<void> => {
    details.set(runningIdentifier, {
      status: 200,
      body: { version: 'v1', detail: runningDetail(false) },
    })
    await boot()
    await openAgent(runningIdentifier)
    expect(page.text('#detail-status')).toContain('Considered stalled in')

    // The deadline has passed since the snapshot was published: the console must decide from the
    // absolute deadline it already holds instead of waiting for a later fetch to say so.
    const published = runningDetail(false)
    details.set(runningIdentifier, {
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
    await page.tick(2_000)
    const requests = page.requestLog.filter((path) => path.startsWith('/api/v1/agents/')).length
    await page.tick(1_000)

    expect(page.text('#detail-status')).toContain('Stalled')
    expect(page.query('#agent-detail').getAttribute('data-state')).toBe('stalled')
    // The one-second refresh recomputes the warning without asking the orchestrator again.
    expect(page.requestLog.filter((path) => path.startsWith('/api/v1/agents/')).length).toBe(
      requests,
    )
  })

  it('ignores a stale detail response that finishes after a newer one', async (): Promise<void> => {
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
    await boot()
    await openAgent(runningIdentifier)
    await page.tick(2_000)
    expect(page.text('#detail-operation')).toBe('Fresh operation')

    releaseFirst(jsonResponse(200, { version: 'v1', detail: stale }))
    await page.flush()

    expect(page.text('#detail-operation')).toBe('Fresh operation')
  })

  it('recovers after a failed detail request', async (): Promise<void> => {
    details.set(runningIdentifier, {
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
    await openAgent(runningIdentifier)

    expect(page.text('#detail-status')).toContain('The agent session is still starting')
    expect(page.query('#agent-detail').getAttribute('data-state')).toBe('error')

    details.set(runningIdentifier, {
      status: 200,
      body: { version: 'v1', detail: runningDetail() },
    })
    await page.tick(2_000)

    expect(page.text('#detail-status')).not.toContain('still starting')
    expect(page.text('#detail-timeline')).toContain('Command pnpm')
  })

  it('keeps the timeline retention notice', async (): Promise<void> => {
    const published = runningDetail()
    details.set(runningIdentifier, {
      status: 200,
      body: {
        version: 'v1',
        detail: { ...published, timeline: { ...published.timeline, dropped: 12 } },
      },
    })
    await boot()
    await openAgent(runningIdentifier)

    expect(page.text('#detail-timeline')).toContain('12 earlier events were dropped')
  })

  it('copies the deep link on request', async (): Promise<void> => {
    await boot()
    await openAgent(runningIdentifier)

    page.query('#detail-copy').click()
    await page.flush()

    expect(page.text('#notice')).toBe('Deep link copied.')
  })

  it('keeps polling the dashboard while a detail request is outstanding', async (): Promise<void> => {
    await boot()
    detailPending = true
    await openAgent(runningIdentifier)
    const before = page.requestLog.filter((path) => path === '/api/v1/state').length

    await page.tick(2_000)
    await page.tick(3_000)

    expect(page.requestLog.filter((path) => path === '/api/v1/state').length).toBeGreaterThan(
      before,
    )
  })
})
