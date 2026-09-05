// One work item, rendered. A card carries the item's placement, why it sits there, and the single
// control the operator can act on — so the action, the confirmation it may need, the request it
// makes, and the note the row shows afterwards all live here beside the card itself.

/** What a row is currently reporting about a mutation the operator asked for. */
type RowFeedback = Readonly<{
  tone: 'pending' | 'success' | 'failure'
  message: string
  /** Set for a failure so the row can offer the same action again. */
  retry: (() => void) | null
}>

const rowFeedback = new Map<string, RowFeedback>()
const inFlight = new Set<string>()

const identifierKey = (identifier: string): string => statusClass(identifier)

const stateChip = (item: WorkItem): HTMLElement =>
  chip(`state-${item.state}`, workStateLabels[item.state])

const phaseChip = (item: WorkItem): HTMLElement =>
  chip(`phase-${item.phase}`, phaseLabels[item.phase])

const eligibilityChip = (item: WorkItem): HTMLElement =>
  chip(`eligibility-${item.eligibility}`, eligibilityLabels[item.eligibility])

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
  start: 'Makes the issue eligible and asks Sloppenheimer to reselect; a free slot starts it now.',
  queue: 'Makes the issue eligible. Sloppenheimer starts it as soon as a dispatch slot is free.',
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
  summary.textContent = `View blockers (${item.blockers.length})`
  summary.setAttribute('aria-label', `View the blockers of ${item.identifier}: ${item.title}`)
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
    `Pausing ${item.identifier} cancels the agent that is running for it and drops any queued retry. Continue?`,
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
    await post(`/api/v1/issues/${issueNumber}/${enable ? 'start' : 'pause'}`)
    await post('/api/v1/refresh')
    await Promise.all([loadState(), loadBacklog()])
    setFeedback(item.identifier, {
      tone: 'success',
      message: enable
        ? item.queueReason === null
          ? 'Eligible. Sloppenheimer is selecting work and will start it shortly.'
          : `Queued: ${item.queueReason}. It starts when a slot frees.`
        : 'Paused. Sloppenheimer will not select this issue.',
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
  const label =
    item.phase === 'delivering' && item.action === 'start'
      ? 'Resume delivery'
      : actionLabels[item.action]
  const button = text('button', `action action-${item.action}`, label)
  button.type = 'button'
  // The same item is rendered in more than one list — a state view and the complete work list —
  // so the description's id is scoped to the list it belongs to rather than to the issue alone.
  const describedBy = `${scope}-action-help-${identifierKey(item.identifier)}`
  button.setAttribute('aria-describedby', describedBy)
  button.setAttribute('aria-label', `${label} for ${item.identifier}: ${item.title}`)
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
  const node = text('p', `row-feedback tone-${feedback.tone}`, feedback.message)
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
    chips.append(chip(`attention-${item.attention}`, attentionLabels[item.attention]))
  }
  chips.append(chip('priority', item.priority === null ? 'No priority' : `P${item.priority}`))
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
    card.append(text('p', 'work-finished', `Finished ${formatAgo(item.finishedAt, Date.now())}`))
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
    inspect.setAttribute('aria-label', `Inspect the agent for ${item.identifier}`)
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
