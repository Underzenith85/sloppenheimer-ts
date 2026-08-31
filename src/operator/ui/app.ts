// The operator console shell. It is organised around the four questions an operator asks — what
// needs attention, what is ready, what is running, what finished — and keeps planning detail,
// which is large and rarely the next action, behind a secondary view.

type WorkView = 'attention' | 'ready' | 'progress' | 'finished'

/** What a row is currently reporting about a mutation the operator asked for. */
type RowFeedback = Readonly<{
  tone: 'pending' | 'success' | 'failure'
  message: string
  /** Set for a failure so the row can offer the same action again. */
  retry: (() => void) | null
}>

/**
 * Below this width the console lays work out as cards rather than as rows. It is read from
 * `innerWidth` rather than from a media query so the rendered DOM — not only its styling — differs,
 * which is what lets the small-screen contract be asserted.
 */
const compactWidth = 768

const views: readonly WorkView[] = ['attention', 'ready', 'progress', 'finished']

let state: OrchestratorSnapshot | null = null
let backlog: BacklogSnapshot | null = null
let model: WorkModel = buildWorkModel(null, null, Date.now())
let activeView: WorkView = 'ready'
/** Whether the operator has chosen a view. Until they do, the default follows the work. */
let viewPinned = false
let planOpen = false
let planFocus = ''
let searchTerm = ''
const stateFilters = new Set<WorkState>()
const rowFeedback = new Map<string, RowFeedback>()
const inFlight = new Set<string>()

const layoutMode = (): 'compact' | 'regular' =>
  window.innerWidth < compactWidth ? 'compact' : 'regular'

const identifierKey = (identifier: string): string => statusClass(identifier)

const stateChip = (item: WorkItem): HTMLElement =>
  chip('state-' + item.state, workStateLabels[item.state])

const phaseChip = (item: WorkItem): HTMLElement =>
  chip('phase-' + item.phase, phaseLabels[item.phase])

const eligibilityChip = (item: WorkItem): HTMLElement =>
  chip('eligibility-' + item.eligibility, eligibilityLabels[item.eligibility])

const actionLabels: Readonly<Record<ActionKind, string>> = {
  start: 'Start agent',
  queue: 'Queue issue',
  pause: 'Pause',
  blockers: 'View blockers',
  none: '',
}

/**
 * What each control actually does, spelled out for the operator rather than left to a `title`
 * attribute. These are the descriptions the row's action is labelled by.
 */
const actionDescriptions: Readonly<Record<ActionKind, string>> = {
  start: 'Makes the issue eligible and asks Symphony to reselect; a free slot starts it now.',
  queue: 'Makes the issue eligible. No dispatch slot is free, so it starts when one is.',
  pause:
    'Removes the issue from orchestration, cancels its running agent, and drops queued retries.',
  blockers: 'Lists the unresolved dependencies that are holding this issue back.',
  none: '',
}

const setFeedback = (identifier: string, feedback: RowFeedback | null): void => {
  if (feedback === null) {
    rowFeedback.delete(identifier)
  } else {
    rowFeedback.set(identifier, feedback)
  }
  render()
}

/**
 * A poll must not silently erase what the operator was just told. A pending note is kept until its
 * request settles; a settled note is superseded only once the runtime shows the state it promised.
 */
const reconcileFeedback = (next: WorkModel): void => {
  const byIdentifier = new Map<string, WorkItem>()
  for (const item of [
    ...next.attention,
    ...next.ready,
    ...next.blocked,
    ...next.progress,
    ...next.finished,
  ]) {
    byIdentifier.set(item.identifier, item)
  }
  for (const [identifier, feedback] of [...rowFeedback]) {
    if (feedback.tone !== 'success') {
      continue
    }
    const item = byIdentifier.get(identifier)
    if (item !== undefined && item.state === 'progress') {
      rowFeedback.delete(identifier)
    }
  }
}

const blockerDisclosure = (item: WorkItem): HTMLElement => {
  const wrapper = document.createElement('details')
  wrapper.className = 'blockers'
  const summary = document.createElement('summary')
  summary.textContent = 'View blockers (' + String(item.blockers.length) + ')'
  summary.setAttribute('aria-label', 'View the blockers of ' + item.identifier + ': ' + item.title)
  wrapper.append(summary)
  const list = document.createElement('ul')
  for (const blocker of item.blockers) {
    const entry = document.createElement('li')
    if (blocker.url === null) {
      entry.textContent = blocker.identifier
    } else {
      const link = text('a', '', blocker.identifier)
      link.href = blocker.url
      entry.append(link)
    }
    list.append(entry)
  }
  if (item.blockers.length === 0) {
    list.append(text('li', '', 'No unresolved blockers are recorded.'))
  }
  const plan = text('button', 'link-button', 'Show in the dependency plan')
  plan.type = 'button'
  plan.addEventListener('click', () => {
    planFocus = item.identifier
    openPlan()
  })
  wrapper.append(list, plan)
  return wrapper
}

const confirmPause = (item: WorkItem): boolean => {
  const interrupts =
    item.phase === 'running' || item.phase === 'starting' || item.phase === 'retrying'
  if (!interrupts) {
    return true
  }
  return window.confirm(
    'Pausing ' +
      item.identifier +
      ' cancels the agent that is running for it and drops any queued retry. Continue?',
  )
}

const runAction = async (item: WorkItem, enable: boolean): Promise<void> => {
  const issueNumber = item.issueNumber
  if (issueNumber === null || inFlight.has(item.identifier)) {
    return
  }
  inFlight.add(item.identifier)
  setFeedback(item.identifier, {
    tone: 'pending',
    message: enable ? 'Requesting orchestration…' : 'Pausing…',
    retry: null,
  })
  try {
    await post('/api/v1/issues/' + String(issueNumber) + '/' + (enable ? 'start' : 'pause'))
    await post('/api/v1/refresh')
    await Promise.all([loadState(), loadBacklog()])
    setFeedback(item.identifier, {
      tone: 'success',
      message: enable
        ? item.queueReason === null
          ? 'Eligible. Symphony is selecting work and will start it shortly.'
          : 'Queued: ' + item.queueReason + '. It starts when a slot frees.'
        : 'Paused. Symphony will not select this issue.',
      retry: null,
    })
  } catch (error) {
    setFeedback(item.identifier, {
      tone: 'failure',
      message: error instanceof Error ? error.message : 'The action failed.',
      retry: () => {
        void runAction(item, enable)
      },
    })
  } finally {
    inFlight.delete(item.identifier)
  }
}

const actionControl = (item: WorkItem, scope: string): HTMLElement | null => {
  if (item.action === 'none') {
    return null
  }
  if (item.action === 'blockers') {
    return blockerDisclosure(item)
  }
  const button = text('button', 'action action-' + item.action, actionLabels[item.action])
  button.type = 'button'
  // The same item is rendered in more than one list — a state view and the complete work list —
  // so the description's id is scoped to the list it belongs to rather than to the issue alone.
  const describedBy = scope + '-action-help-' + identifierKey(item.identifier)
  button.setAttribute('aria-describedby', describedBy)
  button.setAttribute(
    'aria-label',
    actionLabels[item.action] + ' for ' + item.identifier + ': ' + item.title,
  )
  const busy = inFlight.has(item.identifier)
  button.disabled = busy
  button.setAttribute('aria-busy', String(busy))
  button.addEventListener('click', () => {
    if (item.action === 'pause' && !confirmPause(item)) {
      return
    }
    void runAction(item, item.action !== 'pause')
  })
  const wrapper = document.createElement('div')
  wrapper.className = 'action-cell'
  const help = text('span', 'action-help', actionDescriptions[item.action])
  help.id = describedBy
  wrapper.append(button, help)
  return wrapper
}

const feedbackNode = (item: WorkItem): HTMLElement | null => {
  const feedback = rowFeedback.get(item.identifier)
  if (feedback === undefined) {
    return null
  }
  const node = text('p', 'row-feedback tone-' + feedback.tone, feedback.message)
  node.setAttribute('role', 'status')
  if (feedback.retry !== null) {
    const retry = text('button', 'link-button', 'Try again')
    retry.type = 'button'
    retry.addEventListener('click', feedback.retry)
    node.append(' ', retry)
  }
  return node
}

const workCard = (item: WorkItem, scope: string): HTMLElement => {
  const card = document.createElement('article')
  card.className = 'work-card'
  card.dataset['identifier'] = item.identifier
  card.dataset['state'] = item.state
  const heading = document.createElement('div')
  heading.className = 'work-heading'
  const title = document.createElement('h3')
  if (item.url === null) {
    title.textContent = item.title
  } else {
    const link = text('a', 'issue-link', item.title)
    link.href = item.url
    title.append(link)
  }
  heading.append(title)
  const chips = document.createElement('div')
  chips.className = 'work-chips'
  chips.append(stateChip(item), phaseChip(item), eligibilityChip(item))
  if (item.attention !== null) {
    chips.append(chip('attention-' + item.attention, attentionLabels[item.attention]))
  }
  chips.append(
    chip('priority', item.priority === null ? 'No priority' : 'P' + String(item.priority)),
  )
  heading.append(chips)
  card.append(heading)
  card.append(text('p', 'work-identifier', item.identifier))
  if (item.reason !== null) {
    card.append(text('p', 'work-reason', item.reason))
  }
  if (item.ranking !== null) {
    card.append(text('p', 'work-ranking', item.ranking))
  }
  if (item.finishedAt !== null) {
    card.append(text('p', 'work-finished', 'Finished ' + formatAgo(item.finishedAt, Date.now())))
  }
  if (item.labels.length > 0) {
    const labels = document.createElement('details')
    labels.className = 'work-labels'
    const summary = document.createElement('summary')
    summary.textContent = 'Labels'
    labels.append(summary, text('p', '', item.labels.join(' · ')))
    card.append(labels)
  }
  const controls = document.createElement('div')
  controls.className = 'work-controls'
  if (item.hasDetail) {
    const inspect = text('button', 'inspect', 'Inspect agent')
    inspect.type = 'button'
    inspect.dataset['identifier'] = item.identifier
    inspect.dataset['detailTrigger'] = 'true'
    inspect.setAttribute('aria-controls', 'agent-detail')
    inspect.setAttribute('aria-expanded', 'false')
    inspect.setAttribute('aria-label', 'Inspect the agent for ' + item.identifier)
    inspect.addEventListener('click', () => openDetail(item.identifier, inspect))
    controls.append(inspect)
  }
  if (item.pullRequestUrl !== null) {
    const link = text('a', 'link-button', 'Open pull request')
    link.href = item.pullRequestUrl
    controls.append(link)
  }
  const action = actionControl(item, scope)
  if (action !== null) {
    controls.append(action)
  }
  card.append(controls)
  const feedback = feedbackNode(item)
  if (feedback !== null) {
    card.append(feedback)
  }
  return card
}

const renderList = (container: HTMLElement, items: readonly WorkItem[], empty: string): void => {
  container.dataset['layout'] = layoutMode()
  if (items.length === 0) {
    container.replaceChildren(text('p', 'empty', empty))
    return
  }
  container.replaceChildren(...items.map((item) => workCard(item, container.id)))
}

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
  const heading = text(
    'p',
    'summary-line',
    String(blocked.length) +
      ' issues are waiting on a dependency. The most blocking are ' +
      blocked
        .slice(0, 3)
        .map((item) => item.identifier)
        .join(', ') +
      '.',
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
    String(model.capacity.running) + ' of ' + String(model.capacity.limit) + ' agents busy',
    new Intl.NumberFormat().format(state.totals.totalTokens) + ' tokens',
    formatDuration(state.totals.secondsRunning),
    'updated ' + formatTime(state.generatedAt),
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
    const tab = element('#tab-' + candidate)
    const panel = element('#view-' + candidate)
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
    'Nothing needs attention. Symphony is running unattended.',
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
    'Nothing finished in the ' + finishedWindowLabel + '.',
  )
  element('#finished-scope').textContent = 'Scope: the ' + finishedWindowLabel + '.'
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
        : 'Nothing to do: no exceptions, no dispatchable work, no agents in flight, and nothing finished in the ' +
          finishedWindowLabel +
          '.'
  }
}

const matchesFilters = (item: WorkItem): boolean => {
  if (stateFilters.size > 0 && !stateFilters.has(item.state)) {
    return false
  }
  if (searchTerm.length === 0) {
    return true
  }
  const haystack = (item.identifier + ' ' + item.title + ' ' + item.labels.join(' ')).toLowerCase()
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
  element('#all-work-count').textContent =
    String(matches.length) + ' of ' + String(allWork().length) + ' items'
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
          : focus + ' has no blockers and no dependents.',
      ),
    )
    return
  }
  list.replaceChildren(
    ...relevant.map((edge) => text('li', '', edge.blocker + ' blocks ' + edge.dependent)),
  )
}

const renderPlanFocusOptions = (snapshot: BacklogSnapshot): void => {
  const select = element<HTMLSelectElement>('#plan-focus')
  const everyIssue = text('option', '', 'Every issue')
  everyIssue.value = ''
  const options = [everyIssue]
  for (const node of snapshot.nodes) {
    const option = text('option', '', node.identifier + ' — ' + node.title)
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
  state = await request<OrchestratorSnapshot>('/api/v1/state')
  applyModel()
}

const loadBacklog = async (): Promise<void> => {
  backlog = await request<BacklogSnapshot>('/api/v1/backlog')
  element('#label-note').textContent =
    'Orchestration is controlled by the “' + backlog.controlLabel + '” label'
  applyModel()
}

const refresh = async (): Promise<void> => {
  setNotice('Refreshing Symphony…')
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
    const tab = element('#tab-' + view)
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
        element('#tab-' + next).focus()
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

const graphLayout = (
  snapshot: BacklogSnapshot,
): Readonly<{
  positions: ReadonlyMap<string, Readonly<{ x: number; y: number }>>
  width: number
  height: number
}> => {
  const identifiers = snapshot.nodes.map((node) => node.identifier).sort()
  const present = new Set(identifiers)
  const edges = snapshot.edges.filter(
    (edge) => present.has(edge.blocker) && present.has(edge.dependent),
  )
  const indegree = new Map(identifiers.map((identifier) => [identifier, 0]))
  const outgoing = new Map<string, string[]>(identifiers.map((identifier) => [identifier, []]))
  for (const edge of edges) {
    indegree.set(edge.dependent, (indegree.get(edge.dependent) ?? 0) + 1)
    outgoing.get(edge.blocker)?.push(edge.dependent)
  }
  for (const targets of outgoing.values()) {
    targets.sort()
  }
  const queue = identifiers.filter((identifier) => indegree.get(identifier) === 0)
  const layer = new Map(identifiers.map((identifier) => [identifier, 0]))
  const visited = new Set<string>()
  while (queue.length > 0) {
    queue.sort()
    const identifier = queue.shift()
    if (identifier === undefined) {
      break
    }
    visited.add(identifier)
    for (const dependent of outgoing.get(identifier) ?? []) {
      layer.set(dependent, Math.max(layer.get(dependent) ?? 0, (layer.get(identifier) ?? 0) + 1))
      const remaining = (indegree.get(dependent) ?? 1) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) {
        queue.push(dependent)
      }
    }
  }
  const lastLayer = Math.max(0, ...layer.values())
  for (const identifier of identifiers) {
    if (!visited.has(identifier)) {
      layer.set(identifier, lastLayer + 1)
    }
  }
  const columns = new Map<number, string[]>()
  for (const identifier of identifiers) {
    const column = layer.get(identifier) ?? 0
    const entries = columns.get(column) ?? []
    entries.push(identifier)
    columns.set(column, entries)
  }
  const positions = new Map<string, Readonly<{ x: number; y: number }>>()
  for (const [column, entries] of columns) {
    entries.sort()
    entries.forEach((identifier, row) =>
      positions.set(identifier, { x: 28 + column * 280, y: 30 + row * 150 }),
    )
  }
  return {
    positions,
    width: Math.max(320, (Math.max(0, ...columns.keys()) + 1) * 280),
    height: Math.max(190, ...[...columns.values()].map((entries) => entries.length * 150 + 30)),
  }
}

const runtimeStatus = (node: BacklogSnapshot['nodes'][number]): string => {
  if (node.readiness === 'cyclic') {
    return 'Cyclic'
  }
  if ((state?.running ?? []).some((entry) => entry.identifier === node.identifier)) {
    return 'Running'
  }
  if ((state?.retrying ?? []).some((entry) => entry.identifier === node.identifier)) {
    return 'Retrying'
  }
  const handoff = (state?.handoffs ?? []).find((entry) => entry.identifier === node.identifier)
  if (handoff !== undefined) {
    return phaseLabels[handoffPhases[handoff.state] ?? 'handing_off']
  }
  if (node.readiness === 'completed') {
    return 'Completed'
  }
  return node.readiness === 'blocked' ? 'Blocked' : 'Ready'
}

/**
 * Draws the plan inside a bounded, scrollable stage. The stage's own size is whatever the layout
 * needs, but it lives inside a viewport with a capped height, so a large graph pans rather than
 * stretching the document.
 */
const renderGraph = (snapshot: BacklogSnapshot): void => {
  const graph = element('#dependency-graph')
  if (snapshot.nodes.length === 0) {
    graph.replaceChildren(text('p', 'empty', 'There are no dependency nodes.'))
    return
  }
  const layout = graphLayout(snapshot)
  const stage = document.createElement('div')
  stage.className = 'graph-stage'
  stage.style.width = String(layout.width) + 'px'
  stage.style.height = String(layout.height) + 'px'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'graph-edges')
  svg.setAttribute('width', String(layout.width))
  svg.setAttribute('height', String(layout.height))
  svg.setAttribute('aria-hidden', 'true')
  for (const edge of snapshot.edges) {
    const start = layout.positions.get(edge.blocker)
    const end = layout.positions.get(edge.dependent)
    if (start !== undefined && end !== undefined) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const blocker = snapshot.nodes.find((node) => node.identifier === edge.blocker)
      path.setAttribute('class', blocker?.readiness === 'completed' ? 'satisfied' : 'active')
      const startX = start.x + 224
      const endX = end.x
      const middle = (startX + endX) / 2
      path.setAttribute(
        'd',
        'M ' +
          String(startX) +
          ' ' +
          String(start.y + 48) +
          ' C ' +
          String(middle) +
          ' ' +
          String(start.y + 48) +
          ', ' +
          String(middle) +
          ' ' +
          String(end.y + 48) +
          ', ' +
          String(endX) +
          ' ' +
          String(end.y + 48),
      )
      svg.append(path)
    }
  }
  stage.append(svg)
  for (const node of snapshot.nodes) {
    const position = layout.positions.get(node.identifier)
    if (position === undefined) {
      continue
    }
    const status = runtimeStatus(node)
    const card = document.createElement('a')
    card.className = 'graph-node state-' + statusClass(status)
    card.href = node.url ?? '#'
    card.style.left = String(position.x) + 'px'
    card.style.top = String(position.y) + 'px'
    card.setAttribute(
      'aria-label',
      node.identifier +
        ': ' +
        node.title +
        '. ' +
        status +
        (node.reason === null ? '' : '. ' + node.reason),
    )
    card.append(
      text('span', 'graph-state', status),
      text('strong', '', node.title),
      text('small', '', node.identifier),
    )
    if (node.reason !== null) {
      card.append(text('span', 'graph-reason', node.reason))
    }
    stage.append(card)
  }
  graph.replaceChildren(stage)
}

installNavigation()
installDetailControls()
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
