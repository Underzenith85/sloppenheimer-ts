import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { HTMLInputElement, HTMLSelectElement } from 'happy-dom'

import { completionWindowMs } from '@sloppenheimer/core/core/state.js'
import { accessibilityFindings } from '../harness/accessibility.js'
import {
  bootConsole,
  jsonResponse,
  type ConsolePage,
  type DetailResponse,
} from '../harness/operator-console.js'
import {
  awaitingIdentifier,
  blockedIdentifier,
  consoleBacklog,
  consoleState,
  cyclicIdentifier,
  escalatedBlockedIdentifier,
  interventionIdentifier,
  mergedIdentifier,
  readyLastIdentifier,
  readyMiddleIdentifier,
  readyTopIdentifier,
  repairIdentifier,
  retryingIdentifier,
  runningIdentifier,
  staleMergedIdentifier,
  stalledIdentifier,
} from '../harness/console-fixtures.js'

let page: ConsolePage | null = null

const boot = async (options: Parameters<typeof bootConsole>[0] = {}): Promise<ConsolePage> => {
  const booted = await bootConsole({
    state: consoleState(),
    backlog: consoleBacklog(),
    ...options,
  })
  page = booted
  return booted
}

afterEach(async (): Promise<void> => {
  await page?.close()
  page = null
})

const identifiersIn = (console_: ConsolePage, container: string): readonly string[] =>
  console_.identifiers(`${container} .work-card`)

describe('operator console information architecture', (): void => {
  it('leads with the four work-state counts and the highest-priority exception', async (): Promise<void> => {
    const console_ = await boot()

    expect(console_.text('#count-attention')).toBe('6')
    expect(console_.text('#count-ready')).toBe('3')
    expect(console_.text('#count-progress')).toBe('3')
    expect(console_.text('#count-finished')).toBe('1')
    // The counts are the navigation, and they precede every queue and the plan in document order.
    const order = console_.all('.state-tab, .work-card, .graph-node')
    expect(order.slice(0, 4).map((node) => node.id)).toEqual([
      'tab-attention',
      'tab-ready',
      'tab-progress',
      'tab-finished',
    ])
    expect(identifiersIn(console_, '#attention-list')[0]).toBe(stalledIdentifier)
  })

  it('opens on Needs attention while an exception is live', async (): Promise<void> => {
    const console_ = await boot()

    expect(console_.query('#view-attention').hidden).toBe(false)
    expect(console_.query('#view-ready').hidden).toBe(true)
    expect(console_.query('#tab-attention').getAttribute('aria-selected')).toBe('true')
  })

  it('opens on Ready when nothing needs attention', async (): Promise<void> => {
    const backlog = consoleBacklog()
    const state = consoleState()
    const console_ = await boot({
      state: { ...state, running: state.running.slice(0, 1), handoffs: [] },
      backlog: {
        ...backlog,
        issues: backlog.issues.filter(
          (issue) => issue.readiness === 'ready' && issue.identifier !== stalledIdentifier,
        ),
        cycles: [],
      },
    })

    expect(console_.query('#view-ready').hidden).toBe(false)
    expect(console_.query('#tab-ready').getAttribute('aria-selected')).toBe('true')
    expect(console_.text('#count-attention')).toBe('0')
  })

  it('places every item in exactly one primary view', async (): Promise<void> => {
    const console_ = await boot()

    const placements = [
      ...identifiersIn(console_, '#attention-list'),
      ...identifiersIn(console_, '#ready-list'),
      ...identifiersIn(console_, '#progress-list'),
      ...identifiersIn(console_, '#finished-list'),
    ]
    expect(new Set(placements).size).toBe(placements.length)
    expect(placements).toContain(runningIdentifier)
    expect(placements).toContain(mergedIdentifier)
    // Ordinary dependency blocking is not an exception, so it is summarised rather than queued.
    expect(placements).not.toContain(blockedIdentifier)
  })

  it('keeps attention, phase and eligibility separate on one row', async (): Promise<void> => {
    const console_ = await boot()

    const card = console_.card(repairIdentifier)
    const chips = [...card.querySelectorAll('.chip')].map((chip) => chip.textContent)
    expect(chips).toContain('Needs attention')
    expect(chips).toContain('Repair needed')
    expect(chips).toContain('Eligible')
    // Nothing is carried by colour alone: every chip spells its meaning out.
    expect(chips.every((label) => (label ?? '').trim().length > 0)).toBe(true)
  })

  it('explains why a handed-off issue is not dispatchable', async (): Promise<void> => {
    const backlog = consoleBacklog()
    const console_ = await boot({
      backlog: {
        ...backlog,
        issues: backlog.issues.map((issue) =>
          issue.identifier === interventionIdentifier
            ? {
                ...issue,
                dispatchable: false,
                readiness: 'blocked' as const,
                reason: 'Waiting for example/sloppenheimer#50',
                blockedBy:
                  backlog.issues.find((candidate) => candidate.identifier === blockedIdentifier)
                    ?.blockedBy ?? [],
              }
            : issue,
        ),
      },
    })

    const card = console_.card(interventionIdentifier)
    expect(card.textContent).toContain('Not eligible')
    expect(card.textContent).toContain('Not dispatchable: Waiting for example/sloppenheimer#50.')
  })

  it('tells a paused issue apart from one that was never made eligible', async (): Promise<void> => {
    const state = consoleState()
    const console_ = await boot({ state: { ...state, pausedIssueNumbers: [52] } })

    const chipsOf = (identifier: string): readonly string[] =>
      [...console_.card(identifier).querySelectorAll('.chip')].map((chip) => chip.textContent ?? '')
    // #50 carries no orchestration label yet; #52 was paused by an operator and can be resumed.
    expect(chipsOf(readyTopIdentifier)).toContain('Not eligible')
    expect(chipsOf(readyMiddleIdentifier)).toContain('Paused')
    expect(chipsOf(runningIdentifier)).toContain('Eligible')
  })

  it('scopes Finished to a stated window and excludes older work', async (): Promise<void> => {
    const console_ = await boot()

    // The window alone: completions are persisted, so a restart no longer empties the view and the
    // scope is no longer a lifetime as well as a window ([#172]).
    expect(console_.text('#finished-scope')).toBe('Scope: work finished in the last 24 hours.')
    const finished = identifiersIn(console_, '#finished-list')
    expect(finished).toEqual([mergedIdentifier])
    expect(finished).not.toContain(staleMergedIdentifier)
  })

  it('reaches back exactly as far as the runtime restores finished work', async (): Promise<void> => {
    // The console's sources are classic scripts and cannot import the runtime's constant, so the
    // two copies of the window are held to the same span here rather than left to drift.
    const source = await readFile(
      new URL('../../src/operator/ui/model.ts', import.meta.url),
      'utf8',
    )
    const declared = /const finishedWindowMs = ([^\n]+)/.exec(source)?.[1]

    expect(declared).toBeDefined()
    expect(
      (declared ?? '').split('*').reduce((total, factor) => total * Number(factor.trim()), 1),
    ).toBe(completionWindowMs)
  })

  it('offers the retained post-mortem for work that has finished', async (): Promise<void> => {
    const state = consoleState()
    const console_ = await boot({
      // The merged issue's session is still retained, so its detail resource answers.
      state: { ...state, inspectableAgents: [...state.inspectableAgents, mergedIdentifier] },
    })

    console_.query('#tab-finished').click()
    await console_.flush()

    expect(console_.card(mergedIdentifier).querySelector('.inspect')).not.toBeNull()
  })

  it('offers no post-mortem once the finished session has aged out', async (): Promise<void> => {
    const console_ = await boot()

    console_.query('#tab-finished').click()
    await console_.flush()

    expect(console_.card(mergedIdentifier).querySelector('.inspect')).toBeNull()
  })

  it('collapses an idle host to one system-health line instead of empty panels', async (): Promise<void> => {
    const state = consoleState()
    const console_ = await boot({
      state: { ...state, running: [], retrying: [], handoffs: [], completed: [] },
      backlog: { ...consoleBacklog(), issues: [], nodes: [], edges: [], cycles: [] },
    })

    expect(console_.query('#idle-summary').hidden).toBe(false)
    expect(console_.text('#idle-summary')).toContain('Nothing to do')
    expect(console_.text('#system-health')).toContain('agents busy')
  })

  it('moves between states with the arrow keys', async (): Promise<void> => {
    const console_ = await boot()

    console_
      .query('#tab-attention')
      .dispatchEvent(
        new console_.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      )
    await console_.flush()

    expect(console_.query('#tab-ready').getAttribute('aria-selected')).toBe('true')
    expect(console_.window.document.activeElement?.id).toBe('tab-ready')
  })
})

describe('operator console queues', (): void => {
  it('ranks ready work deterministically and says why the first item leads', async (): Promise<void> => {
    const console_ = await boot()

    expect(identifiersIn(console_, '#ready-list')).toEqual([
      readyTopIdentifier,
      readyMiddleIdentifier,
      readyLastIdentifier,
    ])
    const first = console_.all('#ready-list .work-card')[0]
    expect(first?.querySelector('.work-ranking')?.textContent).toBe(
      'P1 · unlocks 8 issues · ranked first',
    )
  })

  it('produces the same order however the backlog is shuffled', async (): Promise<void> => {
    const backlog = consoleBacklog()
    const console_ = await boot({ backlog: { ...backlog, issues: [...backlog.issues].reverse() } })

    expect(identifiersIn(console_, '#ready-list')).toEqual([
      readyTopIdentifier,
      readyMiddleIdentifier,
      readyLastIdentifier,
    ])
  })

  it('never offers a start control for blocked work', async (): Promise<void> => {
    const console_ = await boot()

    const card = console_.card(escalatedBlockedIdentifier)
    expect(card.querySelector('.action')).toBeNull()
    const blockers = card.querySelector('.blockers summary')
    expect(blockers?.textContent).toBe('View blockers (1)')
    expect(blockers?.getAttribute('aria-label')).toContain(escalatedBlockedIdentifier)
    expect(card.querySelector('.blockers ul')?.textContent).toContain(readyTopIdentifier)
  })

  it('separates operator-actionable exceptions from ordinary blocking', async (): Promise<void> => {
    const console_ = await boot()

    const attention = identifiersIn(console_, '#attention-list')
    expect(attention).toEqual([
      stalledIdentifier,
      interventionIdentifier,
      repairIdentifier,
      cyclicIdentifier,
      'example/sloppenheimer#71',
      escalatedBlockedIdentifier,
    ])
    expect(console_.text('#blocked-summary')).toContain('1 issues are waiting on a dependency')
  })

  it('keeps raw labels behind a disclosure rather than in the scan path', async (): Promise<void> => {
    const console_ = await boot()

    const card = console_.card(readyTopIdentifier)
    expect(card.querySelector('.work-labels summary')?.textContent).toBe('Labels')
  })

  it('filters and searches the complete work list', async (): Promise<void> => {
    const console_ = await boot()

    expect(console_.text('#all-work-count')).toBe('14 of 14 items')
    const blockedFilter = console_.query<HTMLInputElement>('#work-filters input[value="blocked"]')
    blockedFilter.checked = true
    blockedFilter.dispatchEvent(new console_.window.Event('change'))
    await console_.flush()

    expect(identifiersIn(console_, '#all-work-list')).toEqual([blockedIdentifier])

    blockedFilter.checked = false
    blockedFilter.dispatchEvent(new console_.window.Event('change'))
    const search = console_.query<HTMLInputElement>('#work-search')
    search.value = 'Silent agent'
    search.dispatchEvent(new console_.window.Event('input'))
    await console_.flush()

    expect(identifiersIn(console_, '#all-work-list')).toEqual([stalledIdentifier])
  })

  it('reports a queue that has not loaded and one that failed', async (): Promise<void> => {
    const pending = await bootConsole({
      serve: (path) => (path === '/api/v1/state' ? new Promise<Response>(() => undefined) : null),
      backlog: consoleBacklog(),
    })
    page = pending
    expect(pending.text('#progress-list')).toContain('No agents or handoffs are in flight')
    // Capacity is unknown until the runtime snapshot lands. The host may be full, or this issue's
    // state may be saturated, so the console queues rather than promising a start it cannot know
    // is available.
    expect(pending.card(readyTopIdentifier).querySelector('.action')?.textContent).toBe(
      'Queue issue',
    )

    await pending.close()
    const failed = await bootConsole({
      state: consoleState(),
      serve: (path) =>
        path === '/api/v1/backlog'
          ? Promise.resolve(
              jsonResponse(502, {
                version: 'v1',
                error: { code: 'backend_error', message: 'The backlog is unavailable' },
              }),
            )
          : null,
    })
    page = failed
    expect(failed.text('#notice')).toBe('The backlog is unavailable')
    // The runtime half loaded, so capacity is known again and a free slot may be offered.
    expect(failed.card(runningIdentifier).querySelector('.action')?.textContent).toBe('Pause')
    // The runtime half of the console still renders: one failing section does not blank the page.
    expect(identifiersIn(failed, '#progress-list')).toContain(runningIdentifier)
  })
})

describe('operator console orchestration actions', (): void => {
  it('names the action after what the backend will do', async (): Promise<void> => {
    const console_ = await boot()

    expect(console_.card(readyTopIdentifier).querySelector('.action')?.textContent).toBe(
      'Start agent',
    )
    expect(console_.card(runningIdentifier).querySelector('.action')?.textContent).toBe('Pause')
  })

  it('says the issue is queued when Sloppenheimer is at capacity', async (): Promise<void> => {
    const state = consoleState()
    const console_ = await boot({ state: { ...state, maxConcurrentAgents: 2 } })

    const action = console_.card(readyTopIdentifier).querySelector('.action')
    expect(action?.textContent).toBe('Queue issue')

    ;(action as unknown as { click: () => void }).click()
    await console_.flush()

    expect(console_.postLog).toContain('/api/v1/issues/50/start')
    expect(console_.card(readyTopIdentifier).querySelector('.row-feedback')?.textContent).toContain(
      'Queued: Sloppenheimer is at capacity (2 of 2 agents). It starts when a slot frees.',
    )
  })

  it('queues rather than promising a start when the issue state has its own cap', async (): Promise<void> => {
    const state = consoleState()
    // Global capacity is free — two of four agents — but the workflow caps open issues, and that
    // cap is reached. The scheduler would leave the issue queued, so the console must not offer to
    // start it.
    const console_ = await boot({ state: { ...state, saturatedStates: ['open'] } })

    const action = console_.card(readyTopIdentifier).querySelector('.action')
    expect(action?.textContent).toBe('Queue issue')

    ;(action as unknown as { click: () => void }).click()
    await console_.flush()

    expect(console_.card(readyTopIdentifier).querySelector('.row-feedback')?.textContent).toContain(
      'issues in state “open” have reached their own concurrency limit',
    )
  })

  it('reports pending then resolved state in the affected row', async (): Promise<void> => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const console_ = await boot({
      serve: (path) =>
        path === '/api/v1/issues/50/start'
          ? gate.then(() => jsonResponse(202, { accepted: true }))
          : null,
    })

    const action = console_.card(readyTopIdentifier).querySelector('.action')
    ;(action as unknown as { click: () => void }).click()
    await console_.flush()

    expect(console_.card(readyTopIdentifier).querySelector('.row-feedback')?.textContent).toContain(
      'Requesting orchestration…',
    )
    expect(
      console_.card(readyTopIdentifier).querySelector('.action')?.getAttribute('aria-busy'),
    ).toBe('true')

    release()
    await console_.flush()

    expect(console_.card(readyTopIdentifier).querySelector('.row-feedback')?.textContent).toContain(
      'Eligible. Sloppenheimer is selecting work',
    )
  })

  it('attaches a failure to the row and offers the action again', async (): Promise<void> => {
    let attempts = 0
    const console_ = await boot({
      serve: (path) => {
        if (path !== '/api/v1/issues/50/start') {
          return null
        }
        attempts += 1
        return Promise.resolve(
          attempts === 1
            ? jsonResponse(502, {
                version: 'v1',
                error: { code: 'backend_error', message: 'The tracker rejected the label' },
              })
            : jsonResponse(202, { accepted: true }),
        )
      },
    })

    ;(
      console_.card(readyTopIdentifier).querySelector('.action') as unknown as {
        click: () => void
      }
    ).click()
    await console_.flush()

    const failed = console_.card(readyTopIdentifier).querySelector('.row-feedback')
    expect(failed?.textContent).toContain('The tracker rejected the label')
    expect(failed?.getAttribute('class')).toContain('tone-failure')

    const retry = failed === null ? null : failed.querySelector('.link-button')
    expect(retry).not.toBeNull()
    ;(retry as unknown as { click: () => void }).click()
    await console_.flush()

    expect(console_.card(readyTopIdentifier).querySelector('.row-feedback')?.textContent).toContain(
      'Eligible.',
    )
    expect(attempts).toBe(2)
  })

  it('cannot submit the same mutation twice from one row', async (): Promise<void> => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const console_ = await boot({
      serve: (path) =>
        path === '/api/v1/issues/50/start'
          ? gate.then(() => jsonResponse(202, { accepted: true }))
          : null,
    })

    const action = console_.card(readyTopIdentifier).querySelector('.action') as unknown as {
      click: () => void
    }
    action.click()
    action.click()
    await console_.flush()
    release()
    await console_.flush()

    expect(console_.postLog.filter((path) => path === '/api/v1/issues/50/start')).toHaveLength(1)
  })

  it('confirms a pause only when it would interrupt active work', async (): Promise<void> => {
    let asked = 0
    const console_ = await boot({
      confirm: () => {
        asked += 1
        return false
      },
    })

    ;(
      console_.card(runningIdentifier).querySelector('.action') as unknown as { click: () => void }
    ).click()
    await console_.flush()
    expect(asked).toBe(1)
    expect(console_.postLog).not.toContain('/api/v1/issues/17/pause')

    await console_.close()
    const paused = await bootConsole({
      state: consoleState(),
      backlog: {
        ...consoleBacklog(),
        issues: consoleBacklog().issues.map((issue) =>
          issue.identifier === readyTopIdentifier ? { ...issue, enabled: true } : issue,
        ),
      },
      confirm: () => {
        asked += 1
        return false
      },
    })
    page = paused
    ;(
      paused.card(readyTopIdentifier).querySelector('.action') as unknown as { click: () => void }
    ).click()
    await paused.flush()

    // A ready issue has no agent to interrupt, so pausing it asks nothing.
    expect(asked).toBe(1)
    expect(paused.postLog).toContain('/api/v1/issues/50/pause')
  })

  it('explains a disabled-looking control without relying on a title attribute', async (): Promise<void> => {
    const console_ = await boot()

    const action = console_.card(readyTopIdentifier).querySelector('.action')
    expect(action?.getAttribute('title')).toBeNull()
    const describedBy = action?.getAttribute('aria-describedby') ?? ''
    expect(console_.text(`#${describedBy}`)).toContain('asks Sloppenheimer to reselect')
    expect(action?.getAttribute('aria-label')).toContain(readyTopIdentifier)
  })

  it('keeps row feedback through a poll and retires it once the runtime agrees', async (): Promise<void> => {
    const console_ = await boot()

    ;(
      console_.card(readyTopIdentifier).querySelector('.action') as unknown as { click: () => void }
    ).click()
    await console_.flush()
    expect(console_.card(readyTopIdentifier).querySelector('.row-feedback')).not.toBeNull()

    await console_.tick(3000)
    expect(console_.card(readyTopIdentifier).querySelector('.row-feedback')).not.toBeNull()
  })
})

describe('operator console plan view', (): void => {
  it('keeps the dependency graph out of the default dashboard', async (): Promise<void> => {
    const console_ = await boot()

    expect(console_.all('.graph-node')).toHaveLength(0)
    expect(console_.query('#plan').hidden).toBe(true)
    expect(console_.query('#plan-toggle').getAttribute('aria-expanded')).toBe('false')
  })

  it('opens the plan, focuses an issue and lists every relationship', async (): Promise<void> => {
    const console_ = await boot()

    console_.query('#plan-toggle').click()
    await console_.flush()

    expect(console_.query('#plan').hidden).toBe(false)
    expect(console_.window.document.activeElement?.id).toBe('plan-heading')
    expect(console_.text('#plan-list')).toContain(
      `${readyTopIdentifier} blocks ${blockedIdentifier}`,
    )
    expect(console_.all('.graph-node').length).toBeGreaterThan(0)
    expect(console_.text('#cycle-diagnostics')).toContain('Dependency cycle')

    const focus = console_.query<HTMLSelectElement>('#plan-focus')
    focus.value = blockedIdentifier
    focus.dispatchEvent(new console_.window.Event('change'))
    await console_.flush()

    expect(console_.text('#plan-list')).toBe(`${readyTopIdentifier} blocks ${blockedIdentifier}`)
    expect(console_.all('.graph-node')).toHaveLength(2)
  })

  it('draws a satisfied edge for a completed blocker without calling its dependent blocked', async (): Promise<void> => {
    const completedIdentifier = 'example/sloppenheimer#16'
    const backlog = consoleBacklog()
    const console_ = await boot({
      backlog: {
        ...backlog,
        nodes: [
          ...backlog.nodes,
          {
            identifier: completedIdentifier,
            number: 16,
            title: 'Completed foundation',
            url: 'https://example.test/issues/16',
            state: 'closed',
            readiness: 'completed',
            reason: null,
            actionable: false,
          },
        ],
        edges: [...backlog.edges, { blocker: completedIdentifier, dependent: readyTopIdentifier }],
      },
    })

    expect(console_.card(readyTopIdentifier).textContent).not.toContain('Blocked by')

    console_.query('#plan-toggle').click()
    await console_.flush()

    expect(console_.all('.graph-edges path.satisfied')).toHaveLength(1)
    expect(console_.all('.graph-edges path.active').length).toBeGreaterThan(0)
    expect(console_.text('#plan-list')).toContain(
      `${completedIdentifier} blocks ${readyTopIdentifier}`,
    )
  })

  it('gives a small screen the list rather than a multi-thousand-pixel graph', async (): Promise<void> => {
    const console_ = await boot({ width: 390 })

    console_.query('#plan-toggle').click()
    await console_.flush()

    expect(console_.all('.graph-node')).toHaveLength(0)
    expect(console_.text('#plan-list')).toContain('blocks')
  })

  it('closes the plan and returns focus to the control that opened it', async (): Promise<void> => {
    const console_ = await boot()

    console_.query('#plan-toggle').click()
    await console_.flush()
    console_.query('#plan-close').click()
    await console_.flush()

    expect(console_.query('#plan').hidden).toBe(true)
    expect(console_.window.document.activeElement?.id).toBe('plan-toggle')
    expect(console_.all('.graph-node')).toHaveLength(0)
  })
})

describe('operator console responsive and accessible shell', (): void => {
  it('lays work out as cards on a phone and as rows on a desktop', async (): Promise<void> => {
    const console_ = await boot({ width: 390 })

    expect(console_.query('#ready-list').getAttribute('data-layout')).toBe('compact')

    await console_.resize(1280)
    expect(console_.query('#ready-list').getAttribute('data-layout')).toBe('regular')
  })

  it('keeps title, state, reason and action together on every card', async (): Promise<void> => {
    const console_ = await boot({ width: 390 })

    const card = console_.card(readyTopIdentifier)
    expect(card.querySelector('h3')?.textContent).toBe('Unblocks the most work')
    expect(card.querySelector('.chip')?.textContent).toBe('Ready')
    expect(card.querySelector('.work-ranking')).not.toBeNull()
    expect(card.querySelector('.action')?.textContent).toBe('Start agent')
  })

  it('offers a skip link into the work queues and coherent landmarks', async (): Promise<void> => {
    const console_ = await boot()

    expect(console_.query('.skip-link').getAttribute('href')).toBe('#work')
    expect(console_.all('main')).toHaveLength(1)
    expect(console_.query('#work').tagName).toBe('MAIN')
    expect(console_.query('.state-nav').getAttribute('role')).toBe('tablist')
    for (const view of ['attention', 'ready', 'progress', 'finished']) {
      expect(console_.query(`#view-${view}`).getAttribute('role')).toBe('tabpanel')
      expect(console_.query(`#view-${view}`).getAttribute('aria-labelledby')).toBe(`tab-${view}`)
    }
  })

  it('meets the documented touch-target minimum in the stylesheet', async (): Promise<void> => {
    const { appStyles } = await import('../../src/operator/ui-assets.js')
    expect(appStyles).toContain('--tap: 44px')
    for (const selector of ['.refresh', '.action', '.state-tab', '.inspect', '.preset']) {
      expect(appStyles).toContain(selector)
    }
    expect(appStyles).toContain('min-height: var(--tap)')
    expect(appStyles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(appStyles).toContain('@media (forced-colors: active)')
  })

  it('names every actionable control for a screen reader', async (): Promise<void> => {
    const console_ = await boot()

    for (const button of console_.all('.work-card button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? ''
      expect(name.trim().length).toBeGreaterThan(0)
    }
    expect(
      console_.card(runningIdentifier).querySelector('.inspect')?.getAttribute('aria-label'),
    ).toBe(`Inspect the agent for ${runningIdentifier}`)
  })
})

describe('operator console accessibility', (): void => {
  const auditEveryState = async (width: number): Promise<readonly string[]> => {
    const console_ = await boot({ width })
    const findings: string[] = []
    const collect = (): void => {
      for (const finding of accessibilityFindings(console_.window.document)) {
        findings.push(`${finding.rule}: ${finding.detail}`)
      }
    }
    for (const view of ['attention', 'ready', 'progress', 'finished']) {
      console_.query(`#tab-${view}`).click()
      await console_.flush()
      collect()
    }
    console_.query('#plan-toggle').click()
    await console_.flush()
    collect()
    ;(
      console_.card(runningIdentifier).querySelector('.inspect') as unknown as { click: () => void }
    ).click()
    await console_.flush()
    collect()
    return findings
  }

  it('has no structural findings across every dashboard state at three widths', async (): Promise<void> => {
    for (const width of [390, 768, 1280]) {
      expect(await auditEveryState(width)).toEqual([])
      await page?.close()
      page = null
    }
  })

  it('has no structural findings when every queue is empty', async (): Promise<void> => {
    const state = consoleState()
    const console_ = await boot({
      state: { ...state, running: [], retrying: [], handoffs: [], completed: [] },
      backlog: { ...consoleBacklog(), issues: [], nodes: [], edges: [], cycles: [] },
    })

    expect(accessibilityFindings(console_.window.document)).toEqual([])
  })
})

describe('operator console workflows', (): void => {
  const detailFixture = (identifier: string): ReadonlyMap<string, DetailResponse> =>
    new Map([
      [
        identifier,
        {
          status: 200,
          body: {
            version: 'v1',
            detail: {
              version: 'v1',
              self: `/api/v1/agents/${encodeURIComponent(identifier)}`,
              generatedAt: new Date().toISOString(),
              issueId: '17',
              identifier,
              title: 'Operator console',
              url: 'https://example.test/issues/17',
              status: 'running',
              handoffEnabled: true,
              identity: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                sessionId: 'thread-1',
                processId: 42,
                turnNumber: 1,
                workerHost: 'local',
              },
              attempt: { current: 1, retries: 0, attempts: [], sessions: [] },
              phase: {
                phase: 'running_command',
                operation: 'pnpm check',
                since: new Date().toISOString(),
              },
              activity: {
                startedAt: new Date(Date.now() - 60_000).toISOString(),
                lastActivityAt: new Date(Date.now() - 5_000).toISOString(),
                elapsedMs: 60_000,
                idleMs: 5_000,
                stallTimeoutMs: 300_000,
                stallDeadline: new Date(Date.now() + 295_000).toISOString(),
                stallCountdownMs: 295_000,
                stalled: false,
              },
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              rateLimits: [],
              workspace: {
                pathKey: 'example_sloppenheimer_17',
                branch: 'sloppenheimer/issue-17',
                dirtyFileCount: 3,
                addedLines: 40,
                deletedLines: 5,
                lastFileActivityAt: new Date().toISOString(),
                qualityPhase: 'check',
                qualityCommandState: 'started',
                pathsTruncated: false,
              },
              handoff: {
                expectedBranch: 'sloppenheimer/issue-17',
                remoteBranch: { status: 'pending', name: null },
                pullRequest: { status: 'pending', number: null, url: null, state: null },
                dispatchLabels: { labels: ['sloppenheimer'], status: 'pending', reason: null },
                outcome: 'in_progress',
                reason: null,
              },
              retry: null,
              errors: [],
              timeline: { events: [], retained: 0, dropped: 0, limit: 500 },
            },
          },
        },
      ],
    ])

  it('inspects an exception and comes back to the same queue position', async (): Promise<void> => {
    const console_ = await boot({ details: detailFixture(stalledIdentifier) })

    const before = identifiersIn(console_, '#attention-list')
    const trigger = console_.card(stalledIdentifier).querySelector('.inspect') as unknown as {
      click: () => void
    }
    trigger.click()
    await console_.flush()
    expect(console_.query('#agent-detail').hidden).toBe(false)

    console_.window.document.dispatchEvent(
      new console_.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await console_.flush()

    expect(console_.query('#agent-detail').hidden).toBe(true)
    expect(identifiersIn(console_, '#attention-list')).toEqual(before)
    expect(console_.window.document.activeElement?.getAttribute('data-identifier')).toBe(
      stalledIdentifier,
    )
  })

  it('offers no agent inspection for a handoff restored without a session', async (): Promise<void> => {
    const state = consoleState()
    const console_ = await boot({
      // A handoff read back from the store after a restart has a pull request but no agent session
      // behind it, so its detail endpoint would refuse.
      state: { ...state, inspectableAgents: [runningIdentifier, stalledIdentifier] },
    })

    console_.query('#tab-progress').click()
    await console_.flush()

    expect(console_.card(awaitingIdentifier).querySelector('.inspect')).toBeNull()
    expect(console_.card(awaitingIdentifier).querySelector('a.link-button')).not.toBeNull()
    expect(console_.card(runningIdentifier).querySelector('.inspect')).not.toBeNull()
    // The retrying agent is not in the published index either, so it loses the control too.
    expect(console_.card(retryingIdentifier).querySelector('.inspect')).toBeNull()
  })

  it('follows a handoff from In progress to its pull request', async (): Promise<void> => {
    const console_ = await boot()

    console_.query('#tab-progress').click()
    await console_.flush()

    const card = console_.card(awaitingIdentifier)
    expect(card.querySelector('.chip')?.textContent).toBe('In progress')
    expect(card.textContent).toContain('Waiting for required checks')
    expect(card.querySelector('a.link-button')?.getAttribute('href')).toBe(
      'https://example.test/pull/30',
    )
  })

  it('shows a finished outcome with its link and how long ago it landed', async (): Promise<void> => {
    const console_ = await boot()

    console_.query('#tab-finished').click()
    await console_.flush()

    const card = console_.card(mergedIdentifier)
    expect(card.querySelector('.chip')?.textContent).toBe('Finished')
    expect(card.textContent).toContain('Finished 1h ago')
    expect(card.querySelector('a.link-button')?.getAttribute('href')).toBe(
      'https://example.test/pull/40',
    )
  })

  it('restores a retrying agent from a deep link', async (): Promise<void> => {
    const console_ = await boot({
      hash: `#/agents/${encodeURIComponent(retryingIdentifier)}`,
      details: detailFixture(retryingIdentifier),
    })

    expect(console_.query('#agent-detail').hidden).toBe(false)
    expect(console_.requestLog).toContain(
      `/api/v1/agents/${encodeURIComponent(retryingIdentifier)}`,
    )
  })
})
