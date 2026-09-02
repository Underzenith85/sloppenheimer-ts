import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HTMLDetailsElement, HTMLInputElement } from 'happy-dom'

import { publishTrace } from '../../src/operator/api.js'
import type { TracePage } from '@sloppenheimer/core'
import { workflowDefaults } from '@sloppenheimer/core/config/workflow.js'
import { issueId, issueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import type { TraceEvent } from '@sloppenheimer/core/domain/trace.js'
import {
  buildAgentDetail,
  createAgentDetailRecord,
  type AgentDetailSnapshot,
} from '@sloppenheimer/core/telemetry.js'
import { consoleBacklog, consoleState, runningIdentifier } from '../harness/console-fixtures.js'
import { bootConsole, jsonResponse, type ConsolePage } from '../harness/operator-console.js'
import { traceEvent } from '../harness/trace.js'

/**
 * The console's trace view.
 *
 * What is asserted here is the part an operator's safety depends on: that agent-authored text is
 * rendered as text and never as markup, that a large payload is not in the DOM until it is asked
 * for, and that a redacted or truncated field says so on the record it belongs to. The filters and
 * paging are asserted through the requests the console makes, because the server is what applies
 * them — a console that filtered locally would show fewer records than the host retains and call it
 * the whole trace.
 */

const detail = (): AgentDetailSnapshot =>
  buildAgentDetail(
    createAgentDetailRecord({
      issueId: issueId('17'),
      identifier: issueIdentifier(runningIdentifier),
      title: 'Operator console',
      url: 'https://example.test/issues/17',
      attempt: null,
      startedAt: new Date(Date.now() - 60_000),
      workspacePathKey: 'example_sloppenheimer_17',
      expectedBranch: 'sloppenheimer/issue-17',
      dispatchLabels: ['sloppenheimer'],
    }),
    {
      self: '/api/v1/agents/example%2Fsloppenheimer%2317',
      now: new Date(),
      status: 'running',
      stallTimeoutMs: 300_000,
      workerHost: 'local',
      handoffEnabled: true,
      branch: 'sloppenheimer/issue-17',
      retry: null,
    },
  )

const tracePageBody = (
  events: readonly TraceEvent[],
  overrides: Partial<TracePage> = {},
): unknown =>
  publishTrace({
    enabled: true,
    identifier: runningIdentifier,
    events,
    nextAfter: events.at(-1)?.sequence ?? 0,
    hasMore: false,
    malformedRecords: 0,
    limits: workflowDefaults.trace.limits,
    evictions: [],
    evictionsTotal: 0,
    ...overrides,
  })

const records: readonly TraceEvent[] = [
  traceEvent({
    sequence: 1,
    identifier: runningIdentifier,
    category: 'command',
    outcome: 'failed',
    body: {
      kind: 'command',
      commandLine: 'pnpm check',
      stdout: '<script>alert("xss")</script>\nsecond line\n',
      stderr: null,
      exitCode: 1,
      durationMs: 90,
    },
    redacted: true,
    truncations: [
      { field: 'stdout', reason: 'byte_limit', retainedBytes: 40, originalBytes: 8192 },
    ],
  }),
  traceEvent({
    sequence: 2,
    identifier: runningIdentifier,
    category: 'reasoning_summary',
    outcome: 'informational',
    body: { kind: 'reasoning_summary', text: 'Reading the failing assertion.' },
  }),
]

let page: ConsolePage
let respond: (path: string) => unknown

const boot = async (): Promise<ConsolePage> => {
  page = await bootConsole({
    hash: `#/agents/${encodeURIComponent(runningIdentifier)}`,
    state: consoleState(),
    backlog: consoleBacklog(),
    details: new Map([
      [runningIdentifier, { status: 200, body: { version: 'v1', detail: detail() } }],
    ]),
    serve: (path) => {
      if (!path.includes('/trace')) {
        return null
      }
      // The tail is not what these assertions are about, and happy-dom hands the console no
      // readable body for it in any case.
      return path.includes('/trace/stream')
        ? Promise.resolve(new Response(': open\n\n', { status: 200 }))
        : Promise.resolve(jsonResponse(200, respond(path)))
    },
  })
  return page
}

/** Opens the trace disclosure the way a click does, including the event the console listens for. */
const openTracePanel = async (): Promise<void> => {
  const panel = page.query<HTMLDetailsElement>('#detail-trace-panel')
  panel.open = true
  panel.dispatchEvent(new page.window.Event('toggle'))
  await page.flush()
}

beforeEach((): void => {
  respond = (): unknown => tracePageBody(records)
})

afterEach(async (): Promise<void> => {
  await page.close()
})

describe('the console trace view', (): void => {
  it('asks the host for the trace only once the panel is opened', async (): Promise<void> => {
    await boot()
    expect(page.requestLog.some((path) => path.includes('/trace'))).toBe(false)
    await openTracePanel()
    expect(page.requestLog.filter((path) => path.includes('/trace?'))).toHaveLength(1)
  })

  it('renders agent-authored output as text rather than as markup', async (): Promise<void> => {
    await boot()
    await openTracePanel()
    const payload = page.query<HTMLDetailsElement>('#detail-trace .trace-payload')
    payload.open = true
    payload.dispatchEvent(new page.window.Event('toggle'))
    await page.flush()
    // The characters the agent printed are present; the element they spell is not.
    expect(payload.textContent).toContain('<script>alert("xss")</script>')
    expect(payload.querySelector('script')).toBeNull()
    expect(page.query('#agent-detail').querySelector('script')).toBeNull()
    expect(page.text('#detail-trace')).toContain('pnpm check')
  })

  it('marks a record the redactor touched and names every field it cut', async (): Promise<void> => {
    await boot()
    await openTracePanel()
    const first = page.all('#detail-trace .trace-event')[0]
    expect(first?.textContent).toContain('Redacted')
    expect(first?.textContent).toContain('Truncated stdout')
    expect(first?.textContent).toContain('8 KB')
  })

  it('labels a reasoning summary as a summary rather than as reasoning', async (): Promise<void> => {
    await boot()
    await openTracePanel()
    const list = page.query('#detail-trace')
    expect(list.textContent).toContain('Reasoning Summary')
    expect(list.textContent).toContain('Reading the failing assertion.')
  })

  it('keeps a large payload out of the DOM until it is expanded', async (): Promise<void> => {
    await boot()
    await openTracePanel()
    const payload = page.query<HTMLDetailsElement>('#detail-trace .trace-payload')
    expect(payload.textContent).toContain('stdout')
    expect(payload.querySelector('.trace-pre')).toBeNull()
    payload.open = true
    payload.dispatchEvent(new page.window.Event('toggle'))
    await page.flush()
    expect(payload.querySelector('.trace-pre')?.textContent).toContain('second line')
  })

  it('sends the filters to the host rather than applying them locally', async (): Promise<void> => {
    await boot()
    await openTracePanel()
    const command = page
      .all('#detail-trace-filters input[type=checkbox]')
      .find((box) => (box as unknown as HTMLInputElement).value === 'command')
    if (command === undefined) {
      throw new Error('the trace filters offer no command category')
    }
    ;(command as unknown as HTMLInputElement).checked = false
    command.dispatchEvent(new page.window.Event('change'))
    await page.flush()
    const requested = page.requestLog.filter((path) => path.includes('/trace?')).at(-1) ?? ''
    expect(requested).toContain('category=')
    expect(requested).not.toContain('category=command')
    // A filter change re-reads from the beginning: the records it hid may have been on page one.
    expect(requested).toContain('after=0')
  })

  it('offers another page only while the host says there is one', async (): Promise<void> => {
    respond = (path: string): unknown =>
      path.includes('after=2') ? tracePageBody([]) : tracePageBody(records, { hasMore: true })
    await boot()
    await openTracePanel()
    const more = page.query('#detail-trace-more')
    expect(more.hidden).toBe(false)
    more.dispatchEvent(new page.window.Event('click'))
    await page.flush()
    expect(page.requestLog.some((path) => path.includes('after=2'))).toBe(true)
  })

  it('says so plainly when the host retains no trace at all', async (): Promise<void> => {
    respond = (): unknown => tracePageBody([], { enabled: false })
    await boot()
    await openTracePanel()
    expect(page.text('#detail-trace-status')).toContain('High-fidelity capture is off')
    expect(page.text('#detail-trace')).toContain('No durable trace is retained')
  })

  it('reports what retention and a torn write cost, rather than a silent gap', async (): Promise<void> => {
    respond = (): unknown => tracePageBody(records, { malformedRecords: 2, evictionsTotal: 7 })
    await boot()
    await openTracePanel()
    const status = page.text('#detail-trace-status')
    expect(status).toContain('2 unreadable records were skipped')
    expect(status).toContain('7 segments have been evicted')
  })

  it('drops the records when the overlay closes', async (): Promise<void> => {
    await boot()
    await openTracePanel()
    expect(page.all('#detail-trace .trace-event')).toHaveLength(2)
    page.window.location.hash = ''
    await page.flush()
    expect(page.text('#detail-trace')).toContain('No trace records loaded')
  })
})
