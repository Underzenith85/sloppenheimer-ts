// The operator console shell. It is organised around the four questions an operator asks — what
// needs attention, what is ready, what is running, what finished — and keeps planning detail,
// which is large and rarely the next action, behind a secondary view.
//
// The shell owns what the console currently knows and what it is showing: the two snapshots, the
// model folded from them, the active view, the filters, and the polling that keeps all of it
// current. Rendering one work item is `cards.ts`, and drawing the plan is `graph.ts`.

type WorkView = 'attention' | 'ready' | 'progress' | 'finished'

/**
 * Below this width the console lays work out as cards rather than as rows. It is read from
 * `innerWidth` rather than from a media query so the rendered DOM — not only its styling — differs,
 * which is what lets the small-screen contract be asserted.
 */
const compactWidth = 768

const views: readonly WorkView[] = ['attention', 'ready', 'progress', 'finished']

let state: PublishedState | null = null
let backlog: BacklogSnapshot | null = null
let model: WorkModel = buildWorkModel(null, null, Date.now())
let activeView: WorkView = 'ready'
/** Whether the operator has chosen a view. Until they do, the default follows the work. */
let viewPinned = false
let planOpen = false
let planFocus = ''
let searchTerm = ''
const stateFilters = new Set<WorkState>()

const layoutMode = (): 'compact' | 'regular' =>
  window.innerWidth < compactWidth ? 'compact' : 'regular'

const renderAlerts = (): void => {
  const container = element('#attention-alerts')
  if (model.alerts.length === 0) {
    container.replaceChildren()
    return
  }
  container.replaceChildren(
    ...model.alerts.map((alert) => {
      const card = document.createElement('article')
      card.className = 'work-card alert-card'
      card.append(text('h3', '', alert.title), text('p', 'work-reason', alert.detail))
      return card
    }),
  )
}

const renderBlockedSummary = (): void => {
  const container = element('#blocked-summary')
  const blocked = model.blocked
  if (blocked.length === 0) {
    container.replaceChildren(text('p', 'empty', 'Nothing is waiting on a dependency.'))
    return
  }
  const mostBlocking = blocked
    .slice(0, 3)
    .map((item) => item.identifier)
    .join(', ')
  const heading = text(
    'p',
    'summary-line',
    `${blocked.length} issues are waiting on a dependency. The most blocking are ${mostBlocking}.`,
  )
  const open = text('button', 'link-button', 'Open dependency plan')
  open.type = 'button'
  open.addEventListener('click', () => {
    planFocus = ''
    openPlan()
  })
  container.replaceChildren(heading, open)
}

const renderSystemHealth = (): void => {
  const summary = element('#system-health')
  if (state === null) {
    summary.textContent = 'Waiting for the first runtime snapshot…'
    return
  }
  const parts = [
    `${model.capacity.running} of ${model.capacity.limit} agents busy`,
    `${new Intl.NumberFormat().format(state.codex_totals.total_tokens)} tokens`,
    formatDuration(state.codex_totals.seconds_running),
    `updated ${formatTime(state.generated_at)}`,
  ]
  summary.textContent = parts.join(' · ')
}

const renderCounts = (): void => {
  element('#count-attention').textContent = String(model.counts.attention)
  element('#count-ready').textContent = String(model.counts.ready)
  element('#count-progress').textContent = String(model.counts.progress)
  element('#count-finished').textContent = String(model.counts.finished)
}

const selectView = (view: WorkView, pin: boolean): void => {
  activeView = view
  element('#work').dataset['view'] = activeView
  if (pin) {
    viewPinned = true
  }
  for (const candidate of views) {
    const tab = element(`#tab-${candidate}`)
    const panel = element(`#view-${candidate}`)
    const selected = candidate === view
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
    panel.hidden = !selected
  }
}

const renderViews = (): void => {
  renderAlerts()
  renderList(
    element('#attention-list'),
    model.attention,
    'Nothing needs attention. Sloppenheimer is running unattended.',
  )
  renderList(
    element('#ready-list'),
    model.ready,
    'No dependency-cleared work is waiting to be dispatched.',
  )
  renderBlockedSummary()
  renderList(element('#progress-list'), model.progress, 'No agents or handoffs are in flight.')
  renderList(
    element('#finished-list'),
    model.finished,
    `Nothing finished in the ${finishedWindowLabel}.`,
  )
  element('#finished-scope').textContent = `Scope: ${finishedScopeLabel}.`
}

/**
 * The compact system-health summary that stands in for the four queues when there is nothing in
 * any of them, so an idle host is one line rather than four empty panels.
 */
const renderIdleState = (): void => {
  const total =
    model.counts.attention + model.counts.ready + model.counts.progress + model.counts.finished
  element('#work').dataset['idle'] = String(total === 0)
  const idle = element('#idle-summary')
  idle.hidden = total !== 0
  if (total === 0) {
    idle.textContent =
      state === null
        ? 'Waiting for the first runtime snapshot…'
        : `Nothing to do: no exceptions, no dispatchable work, no agents in flight, and nothing finished in the ${finishedWindowLabel}.`
  }
}

const matchesFilters = (item: WorkItem): boolean => {
  if (stateFilters.size > 0 && !stateFilters.has(item.state)) {
    return false
  }
  if (searchTerm.length === 0) {
    return true
  }
  const haystack = `${item.identifier} ${item.title} ${item.labels.join(' ')}`.toLowerCase()
  return haystack.includes(searchTerm)
}

const allWork = (): readonly WorkItem[] => [
  ...model.attention,
  ...model.ready,
  ...model.progress,
  ...model.blocked,
  ...model.finished,
]

const renderAllWork = (): void => {
  const matches = allWork().filter(matchesFilters)
  element('#all-work-count').textContent = `${matches.length} of ${allWork().length} items`
  renderList(element('#all-work-list'), matches, 'No work matches the current filters.')
}

const renderPlanList = (snapshot: BacklogSnapshot, focus: string): void => {
  const list = element('#plan-list')
  const relevant = snapshot.edges.filter(
    (edge) => focus === '' || edge.blocker === focus || edge.dependent === focus,
  )
  if (relevant.length === 0) {
    list.replaceChildren(
      text(
        'li',
        'empty',
        focus === ''
          ? 'No dependency relationships are recorded.'
          : `${focus} has no blockers and no dependents.`,
      ),
    )
    return
  }
  list.replaceChildren(
    ...relevant.map((edge) => text('li', '', `${edge.blocker} blocks ${edge.dependent}`)),
  )
}

const renderPlanFocusOptions = (snapshot: BacklogSnapshot): void => {
  const select = element<HTMLSelectElement>('#plan-focus')
  const everyIssue = text('option', '', 'Every issue')
  everyIssue.value = ''
  const options = [everyIssue]
  for (const node of snapshot.nodes) {
    const option = text('option', '', `${node.identifier} — ${node.title}`)
    option.value = node.identifier
    options.push(option)
  }
  select.replaceChildren(...options)
  select.value = planFocus
}

const renderPlan = (): void => {
  const snapshot = backlog
  if (snapshot === null) {
    return
  }
  renderPlanFocusOptions(snapshot)
  const diagnostics = element('#cycle-diagnostics')
  diagnostics.replaceChildren(...snapshot.cycles.map((cycle) => text('p', '', cycle.message)))
  renderPlanList(snapshot, planFocus)
  const graph = element('#dependency-graph')
  // The graph is drawn only when the plan is open and only where there is room for it. Small
  // screens get the list equivalent, which carries every relationship the graph does.
  if (!planOpen || layoutMode() === 'compact') {
    graph.replaceChildren()
    return
  }
  renderGraph(focusedSnapshot(snapshot, planFocus))
}

/** The plan restricted to one issue, its direct blockers and its direct dependents. */
const focusedSnapshot = (snapshot: BacklogSnapshot, focus: string): BacklogSnapshot => {
  if (focus === '') {
    return snapshot
  }
  const keep = new Set<string>([focus])
  for (const edge of snapshot.edges) {
    if (edge.blocker === focus) {
      keep.add(edge.dependent)
    }
    if (edge.dependent === focus) {
      keep.add(edge.blocker)
    }
  }
  return {
    ...snapshot,
    nodes: snapshot.nodes.filter((node) => keep.has(node.identifier)),
    edges: snapshot.edges.filter((edge) => keep.has(edge.blocker) && keep.has(edge.dependent)),
  }
}

const openPlan = (): void => {
  planOpen = true
  const plan = element('#plan')
  plan.hidden = false
  element('#plan-toggle').setAttribute('aria-expanded', 'true')
  renderPlan()
  element('#plan-heading').focus()
}

const closePlan = (): void => {
  planOpen = false
  element('#plan').hidden = true
  element('#plan-toggle').setAttribute('aria-expanded', 'false')
  element('#dependency-graph').replaceChildren()
}

const render = (): void => {
  renderCounts()
  renderSystemHealth()
  renderViews()
  renderIdleState()
  renderAllWork()
  if (planOpen) {
    renderPlan()
  }
  markExpandedTrigger(detailIdentifier)
}

const applyModel = (): void => {
  const next = buildWorkModel(state, backlog, Date.now())
  reconcileFeedback(next)
  model = next
  if (!viewPinned) {
    selectView(defaultWorkView(model) === 'attention' ? 'attention' : 'ready', false)
  }
  render()
}

const loadState = async (): Promise<void> => {
  state = await request<PublishedState>('/api/v1/state')
  applyModel()
}

const loadBacklog = async (): Promise<void> => {
  backlog = await request<BacklogSnapshot>('/api/v1/backlog')
  element('#label-note').textContent =
    `Orchestration is controlled by the “${backlog.controlLabel}” label`
  applyModel()
}

const refresh = async (): Promise<void> => {
  setNotice('Refreshing Sloppenheimer…')
  try {
    await post('/api/v1/refresh')
    await Promise.all([loadState(), loadBacklog()])
    setNotice('State refreshed.')
  } catch (error) {
    setNotice(error instanceof Error ? error.message : 'Refresh failed')
  }
}

const installNavigation = (): void => {
  for (const view of views) {
    const tab = element(`#tab-${view}`)
    tab.addEventListener('click', () => selectView(view, true))
    tab.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key
      if (key !== 'ArrowRight' && key !== 'ArrowLeft') {
        return
      }
      event.preventDefault()
      const index = views.indexOf(view)
      const next = views[(index + (key === 'ArrowRight' ? 1 : views.length - 1)) % views.length]
      if (next !== undefined) {
        selectView(next, true)
        element(`#tab-${next}`).focus()
      }
    })
  }
  element('#refresh').addEventListener('click', () => {
    void refresh()
  })
  element('#plan-toggle').addEventListener('click', () => {
    if (planOpen) {
      closePlan()
    } else {
      openPlan()
    }
  })
  element('#plan-close').addEventListener('click', () => {
    closePlan()
    element('#plan-toggle').focus()
  })
  element<HTMLSelectElement>('#plan-focus').addEventListener('change', (event) => {
    planFocus = (event.target as HTMLSelectElement).value
    renderPlan()
  })
  element<HTMLInputElement>('#work-search').addEventListener('input', (event) => {
    searchTerm = (event.target as HTMLInputElement).value.trim().toLowerCase()
    renderAllWork()
  })
  for (const input of document.querySelectorAll<HTMLInputElement>('#work-filters input')) {
    input.addEventListener('change', () => {
      const value = input.value as WorkState
      if (input.checked) {
        stateFilters.add(value)
      } else {
        stateFilters.delete(value)
      }
      renderAllWork()
    })
  }
  window.addEventListener('resize', () => {
    render()
  })
}

installNavigation()
installDetailControls()
bindTrace()
selectView('ready', false)
render()
syncFromHash()

Promise.all([loadState(), loadBacklog()]).catch((error: unknown) => {
  setNotice(error instanceof Error ? error.message : 'Could not load operator state')
})
setInterval(() => {
  void loadState().catch(() => undefined)
}, 3000)
setInterval(() => {
  void loadBacklog().catch(() => undefined)
}, 15000)
// Detail polling runs on its own timer and its own request: an open panel can never delay the
// dashboard, and the dashboard can never delay the panel.
setInterval(() => {
  void loadDetail().catch(() => undefined)
}, 2000)
// Elapsed time and the stall countdown are derived from absolute timestamps, so they stay live
// between fetches without asking the orchestrator for anything.
setInterval(() => {
  if (detailIdentifier !== null && detail !== null) {
    renderDetailStatus()
  }
}, 1000)
