// The agent detail overlay. It answers, in this order: what is this agent doing, is it healthy,
// how long has it been at it, what has it actually done, and what happens next. Process identity
// and protocol facts are still here, one disclosure down, because they are what an operator needs
// second rather than first.

type AgentDetailSnapshot = import('@symphony/core/telemetry.js').AgentDetailSnapshot
type AgentTimelineCategory = import('@symphony/core/telemetry.js').AgentTimelineCategory
type AgentTimelineEvent = import('@symphony/core/telemetry.js').AgentTimelineEvent

/** Supplied by the server from the same telemetry module the runtime uses. */
declare const timelineCategories: readonly AgentTimelineCategory[]

type TimelinePreset = 'summary' | 'failures' | 'everything' | 'custom'

/**
 * What Summary keeps. Everything excluded from it is protocol bookkeeping — session handshakes,
 * private reasoning, chat turns, individual tool calls and usage accounting — none of which tells
 * an operator whether the agent is making progress.
 */
const summaryCategories: readonly AgentTimelineCategory[] = [
  'file',
  'command',
  'retry',
  'error',
  'cancellation',
  'handoff',
]

const failureCategories: readonly AgentTimelineCategory[] = ['error', 'retry', 'cancellation']

const presetCategories = (preset: TimelinePreset): readonly AgentTimelineCategory[] => {
  if (preset === 'summary') {
    return summaryCategories
  }
  if (preset === 'failures') {
    return failureCategories
  }
  return timelineCategories
}

const detailPanel = element('#agent-detail')
const detailStatus = element('#detail-status')
const detailTimeline = element('#detail-timeline')
const detailDiagnostics = element('#detail-diagnostics')
const detailSummary = element('#detail-summary')
const detailOutcome = element('#detail-outcome')
const detailPresets = element('#detail-presets')
const detailFilters = element('#detail-filters')
const detailTitle = element('#detail-title')

let activePreset: TimelinePreset = 'summary'
const activeCategories = new Set<AgentTimelineCategory>(summaryCategories)
let detail: AgentDetailSnapshot | null = null
let detailIdentifier: string | null = null
let detailTrigger: HTMLElement | null = null
let detailNotice = ''
let announcedStatus = ''
// Detail requests can outlive the polling interval, so responses are matched to the request that
// asked for them: an older one finishing late must not walk the panel backwards.
let detailRequest = 0

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

/** What the operator should expect to happen next, in one sentence. */
const expectedOutcome = (snapshot: AgentDetailSnapshot): string => {
  const handoff = snapshot.handoff
  if (!snapshot.handoffEnabled) {
    // This host composes no code-review services, so no pull request will be opened for the work.
    return snapshot.status === 'retrying'
      ? 'Handoff is disabled on this host. The next attempt runs on schedule and continues the issue.'
      : 'Handoff is disabled on this host. Symphony continues the issue itself rather than opening a pull request.'
  }
  if (handoff.outcome === 'merged') {
    return 'Merged. Nothing further is scheduled for this issue.'
  }
  if (handoff.outcome === 'intervention_required' || handoff.outcome === 'failed') {
    return 'Needs a human: ' + (handoff.reason ?? 'the handoff could not complete on its own.')
  }
  if (handoff.outcome === 'pull_request_open') {
    const number = handoff.pullRequest.number
    return (
      'A pull request' +
      (number === null ? '' : ' #' + String(number)) +
      ' is open. Symphony watches its checks and reviews, repairs it when asked, and merges it once it is clean.'
    )
  }
  if (handoff.outcome === 'no_branch') {
    return 'No branch was produced, so no pull request will be opened for this attempt.'
  }
  if (snapshot.status === 'retrying') {
    return 'The next attempt runs on schedule; the work so far is kept in the same workspace.'
  }
  return `On completion Symphony publishes ${handoff.expectedBranch ?? 'the issue branch'} with its host credential and opens a pull request for review.`
}

const detailHealth = (snapshot: AgentDetailSnapshot): Readonly<{ kind: string; label: string }> => {
  if (stalledNow(snapshot)) {
    return { kind: 'stalled', label: 'Stalled' }
  }
  if (snapshot.status === 'retrying') {
    return { kind: 'retrying', label: 'Retrying' }
  }
  if (snapshot.errors.length > 0) {
    return { kind: 'errors', label: String(snapshot.errors.length) + ' errors reported' }
  }
  if (snapshot.status === 'completed') {
    return { kind: 'completed', label: 'Session ended' }
  }
  return { kind: 'healthy', label: 'Healthy' }
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

/**
 * The first content after the title: what is happening, whether it is healthy, how long it has
 * been going, when it last did anything, and how much of the workspace it has touched.
 */
const renderDetailSummary = (): void => {
  if (detail === null) {
    detailSummary.replaceChildren()
    detailOutcome.textContent = ''
    return
  }
  const health = detailHealth(detail)
  const header = document.createElement('div')
  header.className = 'detail-health'
  header.append(
    chip('health-' + health.kind, health.label),
    chip('phase', telemetryLabel(detail.phase.phase)),
    chip('attempt', 'Attempt ' + String(detail.attempt.current)),
  )
  const list = document.createElement('dl')
  list.className = 'detail-facts'
  fact(list, 'Current operation', detail.phase.operation ?? telemetryLabel(detail.phase.phase))
  fact(list, 'Elapsed', formatClock(Date.now() - new Date(detail.activity.startedAt).getTime()))
  fact(
    list,
    'Last activity',
    detail.activity.lastActivityAt === null
      ? 'no events yet'
      : formatTime(detail.activity.lastActivityAt),
  )
  fact(
    list,
    'Workspace changes',
    String(detail.workspace.dirtyFileCount) +
      ' files (+' +
      String(detail.workspace.addedLines) +
      ' / −' +
      String(detail.workspace.deletedLines) +
      ')' +
      (detail.workspace.pathsTruncated ? ' · list truncated' : ''),
  )
  fact(
    list,
    'Handoff progress',
    detail.handoff.remoteBranch.status +
      ' branch · pull request ' +
      detail.handoff.pullRequest.status +
      ' · ' +
      detail.handoff.outcome.replaceAll('_', ' '),
    detail.handoff.pullRequest.url,
  )
  fact(list, 'Issue', detail.identifier, detail.url)
  detailSummary.replaceChildren(header, list)
  detailOutcome.textContent = expectedOutcome(detail)
}

/** Process identity, protocol facts and raw accounting: available, but one disclosure down. */
const renderDetailDiagnostics = (): void => {
  if (detail === null) {
    detailDiagnostics.replaceChildren()
    return
  }
  const identity = detail.identity
  const list = document.createElement('dl')
  list.className = 'detail-facts'
  fact(list, 'Session', identity.sessionId ?? 'not started')
  fact(list, 'Thread', identity.threadId ?? '—')
  fact(list, 'Turn', (identity.turnId ?? '—') + ' · #' + String(identity.turnNumber))
  fact(list, 'Process', identity.processId === null ? '—' : String(identity.processId))
  fact(list, 'Worker', identity.workerHost)
  fact(
    list,
    'Attempts',
    String(detail.attempt.current) + ' current · ' + String(detail.attempt.retries) + ' retries',
  )
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
  fact(list, 'Workspace', detail.workspace.pathKey)
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
  detailDiagnostics.replaceChildren(list)
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

const syncFilterControls = (): void => {
  for (const input of detailFilters.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
    input.checked = activeCategories.has(input.value as AgentTimelineCategory)
  }
  for (const button of detailPresets.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-pressed', String(button.dataset['preset'] === activePreset))
  }
}

const applyPreset = (preset: TimelinePreset): void => {
  activePreset = preset
  activeCategories.clear()
  for (const category of presetCategories(preset)) {
    activeCategories.add(category)
  }
  syncFilterControls()
  renderTimeline()
}

const renderDetail = (): void => {
  detailTitle.textContent = detail === null ? (detailIdentifier ?? 'Agent detail') : detail.title
  element('#detail-operation').textContent =
    detail === null ? '' : (detail.phase.operation ?? telemetryLabel(detail.phase.phase))
  renderDetailStatus()
  renderDetailSummary()
  renderDetailDiagnostics()
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
  const presets: readonly (readonly [TimelinePreset, string])[] = [
    ['summary', 'Summary'],
    ['failures', 'Errors and retries'],
    ['everything', 'Everything'],
  ]
  detailPresets.replaceChildren(
    ...presets.map(([preset, label]) => {
      const button = text('button', 'preset', label)
      button.type = 'button'
      button.dataset['preset'] = preset
      button.setAttribute('aria-pressed', String(preset === activePreset))
      button.addEventListener('click', () => applyPreset(preset))
      return button
    }),
  )
  detailFilters.replaceChildren(
    ...timelineCategories.map((category) => {
      const label = document.createElement('label')
      label.className = 'filter'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = activeCategories.has(category)
      input.value = category
      input.addEventListener('change', () => {
        if (input.checked) {
          activeCategories.add(category)
        } else {
          activeCategories.delete(category)
        }
        activePreset = 'custom'
        syncFilterControls()
        renderTimeline()
      })
      label.append(input, text('span', '', telemetryLabel(category)))
      return label
    }),
  )
}

const markExpandedTrigger = (identifier: string | null): void => {
  for (const card of document.querySelectorAll<HTMLElement>('[data-detail-trigger]')) {
    card.setAttribute('aria-expanded', String(card.dataset['identifier'] === identifier))
  }
}

/**
 * Opens the overlay. The same presentation is used at every width — a dialog over the page rather
 * than an inline panel that displaces the queue — so opening detail never moves the row the
 * operator opened it from.
 */
const openDetail = (identifier: string, trigger: HTMLElement | null): void => {
  if (trigger !== null) {
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
  document.body.classList.add('detail-open')
  if (window.location.hash !== deepLink(identifier)) {
    window.location.hash = deepLink(identifier)
  }
  markExpandedTrigger(identifier)
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
  document.body.classList.remove('detail-open')
  markExpandedTrigger(null)
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

const copyDetailLink = async (): Promise<void> => {
  if (detailIdentifier === null) {
    return
  }
  const link = window.location.origin + window.location.pathname + deepLink(detailIdentifier)
  try {
    await navigator.clipboard.writeText(link)
    setNotice('Deep link copied.')
  } catch {
    setNotice('Copy the link from the address bar: ' + link)
  }
}

const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/**
 * Whether a control can actually be reached. Reachability is decided from the DOM — a `hidden`
 * ancestor, or a closed disclosure the node is not the summary of — rather than from layout, which
 * keeps the answer the same whether the page is being rendered or driven by a test.
 */
const isReachable = (node: HTMLElement): boolean => {
  let current: HTMLElement | null = node
  while (current !== null && current !== detailPanel) {
    if (current.hidden) {
      return false
    }
    const parent: HTMLElement | null = current.parentElement
    if (
      parent !== null &&
      parent.tagName === 'DETAILS' &&
      !parent.hasAttribute('open') &&
      current.tagName !== 'SUMMARY'
    ) {
      return false
    }
    current = parent
  }
  return true
}

/** The overlay's focusable controls, in document order, skipping anything unreachable. */
const focusableInDetail = (): readonly HTMLElement[] =>
  [...detailPanel.querySelectorAll<HTMLElement>(focusableSelector)].filter(isReachable)

/**
 * Keeps Tab inside the dialog. The overlay is `aria-modal`, so tabbing past its last control must
 * wrap to its first rather than land on the page it is covering — which is obscured, and which a
 * keyboard user cannot see they have moved into.
 */
const containFocus = (event: KeyboardEvent): void => {
  if (event.key !== 'Tab' || detailIdentifier === null) {
    return
  }
  const focusable = focusableInDetail()
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (first === undefined || last === undefined) {
    event.preventDefault()
    detailTitle.focus()
    return
  }
  const active = document.activeElement
  if (!detailPanel.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
    return
  }
  if (event.shiftKey && (active === first || active === detailTitle)) {
    event.preventDefault()
    last.focus()
    return
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

const installDetailControls = (): void => {
  element('#detail-close').addEventListener('click', () => closeDetail())
  element('#detail-copy').addEventListener('click', () => {
    void copyDetailLink()
  })
  element('#detail-scrim').addEventListener('click', () => closeDetail())
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && detailIdentifier !== null) {
      closeDetail()
      return
    }
    containFocus(event)
  })
  window.addEventListener('hashchange', syncFromHash)
  buildFilters()
  syncFilterControls()
}
