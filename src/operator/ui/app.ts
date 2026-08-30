type OrchestratorSnapshot = import('../../core/orchestrator.js').OrchestratorSnapshot
type BacklogSnapshot = import('../operator.js').BacklogSnapshot
type AgentDetailSnapshot = import('../../telemetry.js').AgentDetailSnapshot
type AgentTimelineCategory = import('../../telemetry.js').AgentTimelineCategory
type AgentTimelineEvent = import('../../telemetry.js').AgentTimelineEvent

type RunningEntry = OrchestratorSnapshot['running'][number]
type RetryingEntry = OrchestratorSnapshot['retrying'][number]
type HandoffEntry = OrchestratorSnapshot['handoffs'][number]
type RuntimeNode = BacklogSnapshot['nodes'][number] | BacklogSnapshot['issues'][number]
type DetailPayload = Readonly<{
  detail?: AgentDetailSnapshot
  error?: Readonly<{ message?: string }>
}>

declare const timelineCategories: readonly AgentTimelineCategory[]

const element = <ElementType extends HTMLElement = HTMLElement>(selector: string): ElementType => {
  const match = document.querySelector<ElementType>(selector)
  if (match === null) {
    throw new Error('Missing UI element: ' + selector)
  }
  return match
}

const csrf = element('meta[name="csrf-token"]').getAttribute('content') ?? ''
const notice = element('#notice')
let state: OrchestratorSnapshot | null = null
let backlog: BacklogSnapshot | null = null

const text = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className: string,
  value: string,
): HTMLElementTagNameMap[Tag] => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = value
  return node
}

const request = async <Value>(path: string, options: RequestInit = {}): Promise<Value> => {
  const response = await fetch(path, options)
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as DetailPayload | null
    const message = payload?.error?.message ?? 'Request failed with HTTP ' + String(response.status)
    throw new Error(message)
  }
  return response.json() as Promise<Value>
}

const formatDuration = (seconds: number): string => {
  if (seconds < 60) {
    return Math.round(seconds) + 's runtime'
  }
  const minutes = Math.floor(seconds / 60)
  return minutes + 'm ' + Math.round(seconds % 60) + 's runtime'
}

const formatTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))

const detailPanel = element('#agent-detail')
const detailStatus = element('#detail-status')
const detailTimeline = element('#detail-timeline')
const detailFacts = element('#detail-facts')
const detailFilters = element('#detail-filters')
const detailTitle = element('#detail-title')

const telemetryLabel = (value: string): string =>
  value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

const activeCategories = new Set(timelineCategories)
let detail: AgentDetailSnapshot | null = null
let detailIdentifier: string | null = null
let detailTrigger: HTMLElement | null = null
let detailNotice = ''
let announcedStatus = ''
// Detail requests can outlive the polling interval, so responses are matched to the request that
// asked for them: an older one finishing late must not walk the panel backwards.
let detailRequest = 0

const formatClock = (milliseconds: number): string => {
  const total = Math.max(Math.round(milliseconds / 1000), 0)
  const minutes = Math.floor(total / 60)
  if (minutes === 0) {
    return String(total) + 's'
  }
  return String(minutes) + 'm ' + String(total % 60).padStart(2, '0') + 's'
}

const deepLink = (identifier: string): string => '#/agents/' + encodeURIComponent(identifier)

const identifierFromHash = (): string | null => {
  const raw = window.location.hash
  if (!raw.startsWith('#/agents/')) {
    return null
  }
  try {
    const decoded = decodeURIComponent(raw.slice('#/agents/'.length))
    return decoded.length === 0 ? null : decoded
  } catch {
    return null
  }
}

const requestStatus = async (
  path: string,
): Promise<
  Readonly<{
    ok: boolean
    status: number
    payload: DetailPayload
  }>
> => {
  const response = await fetch(path)
  const payload = (await response.json().catch(() => ({}))) as DetailPayload
  return { ok: response.ok, status: response.status, payload }
}

const describeEvent = (event: AgentTimelineEvent): string => {
  if (event.category === 'message') {
    const who = event.role === 'user' ? 'User message' : 'Agent message'
    return event.text === null ? who : who + ': ' + event.text + (event.truncated ? '…' : '')
  }
  if (event.category === 'reasoning') {
    return 'Thinking (private reasoning is never retained)'
  }
  if (event.category === 'tool') {
    const bytes =
      event.outputBytes === null ? '' : ' · ' + String(event.outputBytes) + ' output bytes'
    return 'Tool ' + event.name + ' · ' + event.state + bytes
  }
  if (event.category === 'command') {
    const exit = event.exitCode === null ? '' : ' · exit ' + String(event.exitCode)
    const quality = event.quality === null ? '' : ' · ' + event.quality
    return (
      'Command ' +
      event.program +
      ' (' +
      String(event.argumentCount) +
      ' arguments)' +
      quality +
      ' · ' +
      event.state +
      exit
    )
  }
  if (event.category === 'file') {
    const added = event.addedLines === null ? 0 : event.addedLines
    const deleted = event.deletedLines === null ? 0 : event.deletedLines
    return event.change + ' ' + event.path + ' (+' + String(added) + ' / −' + String(deleted) + ')'
  }
  if (event.category === 'usage') {
    const tokens =
      event.tokens === null ? 'no token totals' : String(event.tokens.totalTokens) + ' tokens'
    const limits = event.rateLimits
      .map((window) => window.name + ' ' + String(window.usedPercent ?? 0) + '%')
      .join(', ')
    return 'Usage · ' + tokens + (limits.length === 0 ? '' : ' · ' + limits)
  }
  if (event.category === 'retry') {
    const due = event.dueAt === null ? '' : ' · due ' + formatTime(event.dueAt)
    return (
      'Retry attempt ' +
      String(event.attemptNumber) +
      due +
      (event.reason === null ? '' : ' · ' + event.reason)
    )
  }
  if (event.category === 'error') {
    return (
      event.severity + (event.code === null ? '' : ' [' + event.code + ']') + ': ' + event.message
    )
  }
  if (event.category === 'cancellation') {
    return 'Cancelled: ' + event.reason
  }
  if (event.category === 'handoff') {
    return (
      'Handoff ' +
      event.step.replaceAll('_', ' ') +
      ' · ' +
      event.status +
      (event.message === null ? '' : ' · ' + event.message)
    )
  }
  return event.event + (event.turnNumber === undefined ? '' : ' · turn ' + String(event.turnNumber))
}

// The published snapshot carries absolute timestamps, so the console decides for itself whether the
// deadline has passed since the last fetch rather than waiting for the next one to say so.
const stalledNow = (snapshot: AgentDetailSnapshot): boolean => {
  if (snapshot.activity.stalled) {
    return true
  }
  return (
    snapshot.activity.stallDeadline !== null &&
    new Date(snapshot.activity.stallDeadline).getTime() <= Date.now()
  )
}

const idleNow = (snapshot: AgentDetailSnapshot): number => {
  if (snapshot.activity.lastActivityAt === null) {
    return Date.now() - new Date(snapshot.activity.startedAt).getTime()
  }
  return Date.now() - new Date(snapshot.activity.lastActivityAt).getTime()
}

const waitingExplanation = (snapshot: AgentDetailSnapshot): string => {
  if (snapshot.status === 'retrying' && snapshot.retry !== null) {
    const remaining = new Date(snapshot.retry.dueAt).getTime() - Date.now()
    const because =
      snapshot.retry.reason === null ? 'the attempt did not complete' : snapshot.retry.reason
    return (
      'Retrying because ' +
      because +
      '. Attempt ' +
      String(snapshot.retry.attempt) +
      ' starts in ' +
      formatClock(remaining) +
      '.'
    )
  }
  if (snapshot.status === 'completed') {
    return (
      'The agent session has ended. ' + (snapshot.handoff.reason ?? 'No further work is scheduled.')
    )
  }
  if (stalledNow(snapshot)) {
    return 'Stalled: no protocol activity for ' + formatClock(idleNow(snapshot)) + '.'
  }
  if (snapshot.activity.stallDeadline === null) {
    return (
      (snapshot.phase.operation ?? telemetryLabel(snapshot.phase.phase)) +
      '. Stall detection is disabled.'
    )
  }
  const remaining = new Date(snapshot.activity.stallDeadline).getTime() - Date.now()
  return (
    (snapshot.phase.operation ?? telemetryLabel(snapshot.phase.phase)) +
    '. Considered stalled in ' +
    formatClock(remaining) +
    '.'
  )
}

const renderDetailStatus = (): void => {
  if (detailNotice.length > 0) {
    detailStatus.textContent = detailNotice
    detailPanel.dataset['state'] = 'error'
    return
  }
  if (detail === null) {
    detailStatus.textContent = 'Loading agent detail…'
    return
  }
  const stalled = stalledNow(detail)
  const phase = stalled ? 'stalled' : detail.phase.phase
  element('#detail-phase').textContent = telemetryLabel(phase) + ' · ' + detail.status
  const elapsed = Date.now() - new Date(detail.activity.startedAt).getTime()
  const message = waitingExplanation(detail) + ' Running for ' + formatClock(elapsed) + '.'
  // Only a changed message is written, so a screen reader is not told the same thing every second.
  if (message !== announcedStatus) {
    announcedStatus = message
    detailStatus.textContent = message
  }
  detailPanel.dataset['state'] = stalled ? 'stalled' : detail.status
}

const fact = (list: HTMLDListElement, term: string, value: string, href?: string | null): void => {
  list.append(text('dt', '', term))
  const definition = document.createElement('dd')
  if (href === undefined || href === null) {
    definition.textContent = value
  } else {
    const link = text('a', '', value)
    link.href = href
    definition.append(link)
  }
  list.append(definition)
}

const renderDetailFacts = (): void => {
  const list = document.createElement('dl')
  list.className = 'detail-facts'
  if (detail === null) {
    detailFacts.replaceChildren()
    return
  }
  const identity = detail.identity
  fact(list, 'Issue', detail.identifier, detail.url)
  fact(
    list,
    'Attempt',
    String(detail.attempt.current) + ' · ' + String(detail.attempt.retries) + ' retries',
  )
  fact(list, 'Session', identity.sessionId ?? 'not started')
  fact(list, 'Thread', identity.threadId ?? '—')
  fact(list, 'Turn', (identity.turnId ?? '—') + ' · #' + String(identity.turnNumber))
  fact(list, 'Process', identity.processId === null ? '—' : String(identity.processId))
  fact(list, 'Worker', identity.workerHost)
  fact(
    list,
    'Tokens',
    new Intl.NumberFormat().format(detail.usage.totalTokens) +
      ' (' +
      String(detail.usage.inputTokens) +
      ' in / ' +
      String(detail.usage.outputTokens) +
      ' out)',
  )
  fact(
    list,
    'Rate limits',
    detail.rateLimits.length === 0
      ? 'none reported'
      : detail.rateLimits
          .map((window) => window.name + ' ' + String(window.usedPercent ?? 0) + '%')
          .join(' · '),
  )
  fact(
    list,
    'Last activity',
    detail.activity.lastActivityAt === null
      ? 'no events yet'
      : formatTime(detail.activity.lastActivityAt),
  )
  fact(
    list,
    'Workspace',
    detail.workspace.pathKey +
      ' · ' +
      String(detail.workspace.dirtyFileCount) +
      ' files (+' +
      String(detail.workspace.addedLines) +
      ' / −' +
      String(detail.workspace.deletedLines) +
      ')',
  )
  fact(
    list,
    'Quality command',
    detail.workspace.qualityPhase === null
      ? 'not observed'
      : detail.workspace.qualityPhase + ' · ' + (detail.workspace.qualityCommandState ?? 'unknown'),
  )
  fact(list, 'Expected branch', detail.handoff.expectedBranch ?? '—')
  fact(
    list,
    'Remote branch',
    detail.handoff.remoteBranch.status +
      (detail.handoff.remoteBranch.name === null ? '' : ' · ' + detail.handoff.remoteBranch.name),
  )
  if (detail.handoff.pullRequest.url === null) {
    fact(list, 'Pull request', detail.handoff.pullRequest.status)
  } else {
    fact(
      list,
      'Pull request',
      detail.handoff.pullRequest.status + ' · #' + String(detail.handoff.pullRequest.number),
      detail.handoff.pullRequest.url,
    )
  }
  fact(
    list,
    'Dispatch labels',
    detail.handoff.dispatchLabels.labels.join(', ') + ' · ' + detail.handoff.dispatchLabels.status,
  )
  fact(list, 'Handoff outcome', detail.handoff.outcome.replaceAll('_', ' '))
  detailFacts.replaceChildren(...list.childNodes)
}

const renderTimeline = (): void => {
  if (detail === null) {
    detailTimeline.replaceChildren(
      text('li', 'empty', detailNotice.length > 0 ? detailNotice : 'No events yet.'),
    )
    return
  }
  const events = detail.timeline.events.filter((event) => activeCategories.has(event.category))
  if (events.length === 0) {
    detailTimeline.replaceChildren(text('li', 'empty', 'No events match the selected filters.'))
    return
  }
  const items = events.map((event) => {
    const item = document.createElement('li')
    item.className = 'timeline-event category-' + event.category
    item.append(text('span', 'timeline-time', formatTime(event.at)))
    item.append(text('span', 'timeline-category', telemetryLabel(event.category)))
    item.append(text('span', 'timeline-body', describeEvent(event)))
    item.append(
      text(
        'small',
        'timeline-meta',
        'attempt ' + String(event.attempt) + ' · #' + String(event.sequence),
      ),
    )
    return item
  })
  if (detail.timeline.dropped > 0) {
    items.unshift(
      text(
        'li',
        'timeline-dropped',
        String(detail.timeline.dropped) + ' earlier events were dropped to keep retention bounded.',
      ),
    )
  }
  detailTimeline.replaceChildren(...items)
}

const renderDetail = (): void => {
  detailTitle.textContent = detail === null ? (detailIdentifier ?? 'Agent detail') : detail.title
  element('#detail-operation').textContent = detail === null ? '' : (detail.phase.operation ?? '')
  renderDetailStatus()
  renderDetailFacts()
  renderTimeline()
}

const loadDetail = async (): Promise<void> => {
  if (detailIdentifier === null) {
    return
  }
  const target = detailIdentifier
  detailRequest += 1
  const generation = detailRequest
  try {
    const result = await requestStatus('/api/v1/agents/' + encodeURIComponent(target))
    if (target !== detailIdentifier || generation !== detailRequest) {
      return
    }
    if (result.ok) {
      detail = result.payload.detail ?? null
      detailNotice = ''
    } else {
      detail = null
      detailNotice =
        result.payload?.error?.message ?? 'Detail request failed with HTTP ' + String(result.status)
    }
  } catch {
    if (target !== detailIdentifier || generation !== detailRequest) {
      return
    }
    // A transport failure keeps the last known detail on screen and retries on the next tick.
    detailNotice = 'Agent detail is temporarily unreachable. Retrying…'
  }
  renderDetail()
}

const buildFilters = (): void => {
  const controls = timelineCategories.map((category) => {
    const label = document.createElement('label')
    label.className = 'filter'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = true
    input.value = category
    input.addEventListener('change', () => {
      if (input.checked) {
        activeCategories.add(category)
      } else {
        activeCategories.delete(category)
      }
      renderTimeline()
    })
    label.append(input, text('span', '', telemetryLabel(category)))
    return label
  })
  detailFilters.replaceChildren(...controls)
}

const openDetail = (identifier: string, trigger: HTMLElement | null): void => {
  if (trigger !== undefined && trigger !== null) {
    detailTrigger = trigger
  }
  const changed = detailIdentifier !== identifier
  detailIdentifier = identifier
  if (changed) {
    detail = null
    detailNotice = ''
    announcedStatus = ''
  }
  detailPanel.hidden = false
  if (window.location.hash !== deepLink(identifier)) {
    window.location.hash = deepLink(identifier)
  }
  for (const card of document.querySelectorAll<HTMLElement>('.work-card')) {
    card.setAttribute('aria-expanded', String(card.dataset['identifier'] === identifier))
  }
  renderDetail()
  if (changed) {
    detailTitle.focus()
  }
  loadDetail().catch(() => undefined)
}

const closeDetail = (): void => {
  detailIdentifier = null
  detail = null
  detailNotice = ''
  announcedStatus = ''
  detailPanel.hidden = true
  for (const card of document.querySelectorAll<HTMLElement>('.work-card')) {
    card.setAttribute('aria-expanded', 'false')
  }
  if (window.location.hash.startsWith('#/agents/')) {
    window.location.hash = ''
  }
  if (detailTrigger !== null && document.contains(detailTrigger)) {
    detailTrigger.focus()
  }
  detailTrigger = null
}

const syncFromHash = (): void => {
  const identifier = identifierFromHash()
  if (identifier === null) {
    if (detailIdentifier !== null) {
      closeDetail()
    }
    return
  }
  if (identifier !== detailIdentifier) {
    openDetail(identifier, null)
  }
}

const renderWork = (
  container: HTMLElement,
  entries: readonly (RunningEntry | RetryingEntry)[],
  retrying: boolean,
): void => {
  if (entries.length === 0) {
    container.replaceChildren(
      text('p', 'empty', retrying ? 'No retries are scheduled.' : 'No agents are running.'),
    )
    return
  }
  const cards = entries.map((entry) => {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'work-card'
    card.dataset['identifier'] = entry.identifier
    card.setAttribute('aria-controls', 'agent-detail')
    card.setAttribute('aria-expanded', String(detailIdentifier === entry.identifier))
    const copy = document.createElement('div')
    copy.append(text('strong', '', entry.title), text('span', '', entry.identifier))
    const summary =
      'error' in entry
        ? 'Attempt ' + String(entry.attempt) + ' · ' + (entry.error ?? 'continuing')
        : ('lastEvent' in entry ? (entry.lastEvent ?? 'Starting agent') : 'Starting agent') +
          ' · ' +
          formatTime(entry.startedAt)
    card.append(copy, text('small', '', summary))
    card.setAttribute(
      'aria-label',
      'Inspect ' + entry.identifier + ': ' + entry.title + '. ' + summary,
    )
    card.addEventListener('click', () => openDetail(entry.identifier, card))
    return card
  })
  container.replaceChildren(...cards)
}

const renderHandoffs = (entries: readonly HandoffEntry[]): void => {
  const container = element('#handoff-list')
  if (entries.length === 0) {
    container.replaceChildren(text('p', 'empty', 'No pull requests are being monitored.'))
    return
  }
  container.replaceChildren(
    ...entries.map((entry) => {
      const card = document.createElement('a')
      card.className = 'work-card'
      card.href = entry.pullRequestUrl
      const copy = document.createElement('div')
      copy.append(text('strong', '', entry.identifier), text('span', '', handoffStatus(entry)))
      card.append(copy, text('small', '', entry.reason ?? 'Head ' + (entry.headSha ?? 'pending')))
      return card
    }),
  )
}

const renderState = (snapshot: OrchestratorSnapshot): void => {
  state = snapshot
  element('#running-count').textContent = String(snapshot.counts.running)
  element('#retrying-count').textContent = String(snapshot.counts.retrying)
  element('#completed-count').textContent = String(snapshot.counts.completed)
  element('#capacity').textContent = 'of ' + String(snapshot.maxConcurrentAgents) + ' agents'
  element('#token-count').textContent = new Intl.NumberFormat().format(snapshot.totals.totalTokens)
  element('#runtime').textContent = formatDuration(snapshot.totals.secondsRunning)
  element('#updated-at').textContent = 'Updated ' + formatTime(snapshot.generatedAt)
  renderWork(element('#running-list'), snapshot.running, false)
  renderWork(element('#retry-list'), snapshot.retrying, true)
  renderHandoffs(snapshot.handoffs)
  if (backlog !== null) {
    renderGraph(backlog)
  }
}

const handoffStatus = (handoff: HandoffEntry): string => {
  const labels: Readonly<Record<string, string>> = {
    awaiting_checks: 'Awaiting checks',
    repair_needed: 'Repair needed',
    ready_to_merge: 'Ready to merge',
    merging: 'Merging',
    closed_without_merge: 'Closed without merge',
    intervention_required: 'Needs intervention',
    merged: 'Merged',
  }
  return labels[handoff.state] ?? 'PR handoff'
}

const runtimeStatus = (node: RuntimeNode): string => {
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
    return handoffStatus(handoff)
  }
  if (node.readiness === 'completed') {
    return 'Completed'
  }
  return node.readiness === 'blocked' ? 'Blocked' : 'Ready'
}

const statusClass = (status: string): string =>
  status
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/(^-|-$)/g, '')

const graphLayout = (
  snapshot: BacklogSnapshot,
): Readonly<{
  positions: ReadonlyMap<string, Readonly<{ x: number; y: number }>>
  width: number
  height: number
}> => {
  const identifiers = snapshot.nodes.map((node) => node.identifier).sort()
  const indegree = new Map(identifiers.map((identifier) => [identifier, 0]))
  const outgoing = new Map<string, string[]>(identifiers.map((identifier) => [identifier, []]))
  for (const edge of snapshot.edges) {
    if (indegree.has(edge.blocker) && indegree.has(edge.dependent)) {
      indegree.set(edge.dependent, (indegree.get(edge.dependent) ?? 0) + 1)
      outgoing.get(edge.blocker)?.push(edge.dependent)
    }
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

const renderGraph = (snapshot: BacklogSnapshot): void => {
  const graph = element('#dependency-graph')
  const diagnostics = element('#cycle-diagnostics')
  if (snapshot.cycles.length === 0) {
    diagnostics.replaceChildren()
  } else {
    diagnostics.replaceChildren(...snapshot.cycles.map((cycle) => text('p', '', cycle.message)))
  }
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

const action = async (
  issueNumber: number,
  enabled: boolean,
  button: HTMLButtonElement,
): Promise<void> => {
  button.disabled = true
  notice.textContent = enabled ? 'Adding issue to the score…' : 'Pausing issue…'
  try {
    await request<unknown>(
      '/api/v1/issues/' + String(issueNumber) + '/' + (enabled ? 'start' : 'pause'),
      {
        method: 'POST',
        headers: { 'X-Symphony-CSRF': csrf },
      },
    )
    await request<unknown>('/api/v1/refresh', {
      method: 'POST',
      headers: { 'X-Symphony-CSRF': csrf },
    })
    await Promise.all([loadState(), loadBacklog()])
    notice.textContent = enabled ? 'Issue enabled. Symphony is selecting work.' : 'Issue paused.'
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : 'The action failed'
  } finally {
    button.disabled = false
  }
}

const renderBacklog = (snapshot: BacklogSnapshot): void => {
  backlog = snapshot
  element('#label-note').textContent = 'Controlled by the “' + snapshot.controlLabel + '” label'
  const body = element('#backlog')
  if (snapshot.issues.length === 0) {
    const row = document.createElement('tr')
    const cell = text('td', 'empty', 'There are no open issues.')
    cell.colSpan = 5
    row.append(cell)
    body.replaceChildren(row)
    return
  }
  renderGraph(snapshot)
  const rows = snapshot.issues.map((issue) => {
    const row = document.createElement('tr')
    const issueCell = document.createElement('td')
    const link = text('a', 'issue-link', '#' + String(issue.number) + ' ' + issue.title)
    link.href = issue.url ?? '#'
    issueCell.append(link)
    if (issue.blockedBy.length > 0) {
      const blockers = document.createElement('span')
      blockers.className = 'blocker-links'
      blockers.append('Blocked by ')
      issue.blockedBy.forEach((blocker, index) => {
        const blockerLink = text('a', '', blocker.identifier)
        blockerLink.href = blocker.url
        blockers.append(index === 0 ? '' : ', ', blockerLink)
      })
      issueCell.append(blockers)
    }
    const priority = text('td', '', issue.priority === null ? '—' : 'P' + String(issue.priority))
    const labels = text(
      'td',
      'labels',
      issue.labels.filter((label) => label !== snapshot.controlLabel).join(' · ') || '—',
    )
    const graphNode = snapshot.nodes.find((node) => node.identifier === issue.identifier)
    const stateName = runtimeStatus(graphNode ?? issue)
    const status = text('td', '', stateName)
    status.append(text('span', 'status-dot state-' + statusClass(stateName), ''))
    if (issue.reason !== null) {
      status.append(text('small', 'status-reason', issue.reason))
    }
    const actionCell = document.createElement('td')
    const button = text(
      'button',
      issue.enabled ? 'action pause' : 'action start',
      issue.enabled ? 'Pause' : 'Start',
    )
    button.type = 'button'
    button.disabled = !issue.enabled && issue.readiness !== 'ready'
    if (button.disabled) {
      button.title = issue.reason ?? 'Issue is not ready'
    }
    button.addEventListener('click', () => {
      void action(issue.number, !issue.enabled, button)
    })
    actionCell.append(button)
    row.append(issueCell, priority, labels, status, actionCell)
    return row
  })
  body.replaceChildren(...rows)
}

const loadState = async (): Promise<void> =>
  renderState(await request<OrchestratorSnapshot>('/api/v1/state'))
const loadBacklog = async (): Promise<void> =>
  renderBacklog(await request<BacklogSnapshot>('/api/v1/backlog'))

const refresh = async (): Promise<void> => {
  notice.textContent = 'Refreshing Symphony…'
  try {
    await request<unknown>('/api/v1/refresh', {
      method: 'POST',
      headers: { 'X-Symphony-CSRF': csrf },
    })
    await Promise.all([loadState(), loadBacklog()])
    notice.textContent = 'State refreshed.'
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : 'Refresh failed'
  }
}

element('#refresh').addEventListener('click', () => {
  void refresh()
})

element('#detail-close').addEventListener('click', () => closeDetail())

const copyDetailLink = async (): Promise<void> => {
  if (detailIdentifier === null) {
    return
  }
  const link = window.location.origin + window.location.pathname + deepLink(detailIdentifier)
  try {
    await navigator.clipboard.writeText(link)
    notice.textContent = 'Deep link copied.'
  } catch {
    notice.textContent = 'Copy the link from the address bar: ' + link
  }
}

element('#detail-copy').addEventListener('click', () => {
  void copyDetailLink()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && detailIdentifier !== null) {
    closeDetail()
  }
})

window.addEventListener('hashchange', syncFromHash)

buildFilters()
syncFromHash()

Promise.all([loadState(), loadBacklog()]).catch((error) => {
  notice.textContent = error instanceof Error ? error.message : 'Could not load operator state'
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
