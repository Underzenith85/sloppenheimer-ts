// The agent detail overlay. It answers, in this order: what is this agent doing, is it healthy,
// how long has it been at it, what has it actually done, and what happens next. Process identity
// and protocol facts are still here, one disclosure down, because they are what an operator needs
// second rather than first.
//
// This file is the overlay itself: the panel's state, what opens and closes it, the deep link it
// keeps in the address bar, and the focus it contains. The prose it renders comes from `explain.ts`
// and the event list from `timeline.ts`.

const detailPanel = element('#agent-detail')
const detailStatus = element('#detail-status')
const detailDiagnostics = element('#detail-diagnostics')
const detailSummary = element('#detail-summary')
const detailOutcome = element('#detail-outcome')
const detailTitle = element('#detail-title')

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
