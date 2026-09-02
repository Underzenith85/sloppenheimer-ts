// How one row of either snapshot becomes one work item. Every constructor here answers the same
// question for a different source — a running agent, a queued retry, a pull-request handoff, a
// completion, a backlog issue — and `buildWorkModel` in `model.ts` is what folds their results into
// one placement per identifier.

const issueNumberOf = (identifier: string): number | null => {
  const match = /#(\d+)$/u.exec(identifier)
  return match?.[1] === undefined ? null : Number(match[1])
}

const blockerList = (issue: BacklogIssue): readonly Blocker[] =>
  issue.blockedBy.map((blocker) => ({ identifier: blocker.identifier, url: blocker.url }))

const blockerSummary = (blockers: readonly Blocker[]): string => {
  if (blockers.length === 0) {
    return 'No unresolved blockers'
  }
  const first = blockers[0]?.identifier ?? ''
  return blockers.length === 1
    ? `Blocked by ${first}`
    : `Blocked by ${first} and ${blockers.length - 1} more`
}

const stalledNowAt = (deadline: string | null, now: number): boolean =>
  deadline !== null && new Date(deadline).getTime() <= now

const eligibilityOf = (
  issue: BacklogIssue | undefined,
  paused: ReadonlySet<number>,
): Eligibility => {
  if (issue === undefined) {
    return 'not_eligible'
  }
  if (paused.has(issue.number)) {
    return 'paused'
  }
  return issue.enabled && issue.dispatchable ? 'eligible' : 'not_eligible'
}

const ineligibilityReason = (
  issue: BacklogIssue | undefined,
  paused: ReadonlySet<number>,
): string | null => {
  if (issue === undefined) {
    return 'the tracker no longer reports the issue'
  }
  if (paused.has(issue.number)) {
    return 'the issue is paused by an operator'
  }
  if (!issue.enabled) {
    return 'the required dispatch label is absent'
  }
  if (!issue.dispatchable) {
    return issue.reason ?? 'the tracker reports the issue is not dispatchable'
  }
  return null
}

/**
 * The system-level exceptions. They belong to the host rather than to any one issue, so they are
 * reported alongside the attention queue instead of being attached to an arbitrary row.
 */
const systemAlerts = (state: PublishedState | null): readonly SystemAlert[] => {
  if (state === null) {
    return []
  }
  const alerts: SystemAlert[] = []
  if (state.workflow_reload_error !== null) {
    alerts.push({
      key: 'workflow-reload',
      title: 'Workflow reload failed',
      detail: `${state.workflow_reload_error.message} — the last good workflow is still in force.`,
    })
  }
  const recovery = state.handoff_recovery
  if (recovery.status === 'degraded' || recovery.failed > 0) {
    alerts.push({
      key: 'handoff-recovery',
      title: 'Handoff recovery is degraded',
      detail:
        `${recovery.failed} of ${recovery.loaded} stored handoffs could not be recovered` +
        (recovery.store_error === null ? '.' : `: ${recovery.store_error.message}`),
    })
  }
  return alerts
}

const runningItem = (
  entry: RunningEntry,
  issue: BacklogIssue | undefined,
  paused: ReadonlySet<number>,
  inspectable: ReadonlySet<string>,
  now: number,
): WorkItem => {
  const stalled = stalledNowAt(entry.stall_deadline, now)
  return {
    identifier: entry.issue_identifier,
    issueNumber: issue?.number ?? issueNumberOf(entry.issue_identifier),
    title: entry.title,
    url: entry.issue_url,
    state: stalled ? 'attention' : 'progress',
    attention: stalled ? 'stalled' : null,
    phase: entry.last_event === null ? 'starting' : 'running',
    eligibility: eligibilityOf(issue, paused),
    priority: issue?.priority ?? null,
    labels: issue?.labels ?? [],
    reason: stalled
      ? 'No protocol activity before the stall deadline.'
      : (entry.last_event ?? 'Starting agent'),
    ranking: stalled ? attentionRanking('stalled', issue?.priority ?? null) : null,
    blockers: [],
    unlocks: issue?.unlocks ?? 0,
    hasDetail: inspectable.has(entry.issue_identifier),
    queueReason: null,
    finishedAt: null,
    pullRequestUrl: null,
    action: 'pause',
  }
}

const retryingItem = (
  entry: RetryingEntry,
  issue: BacklogIssue | undefined,
  paused: ReadonlySet<number>,
  inspectable: ReadonlySet<string>,
): WorkItem => ({
  identifier: entry.issue_identifier,
  issueNumber: issue?.number ?? issueNumberOf(entry.issue_identifier),
  title: entry.title,
  url: entry.issue_url,
  state: 'progress',
  attention: null,
  phase: 'retrying',
  eligibility: eligibilityOf(issue, paused),
  priority: issue?.priority ?? null,
  labels: issue?.labels ?? [],
  reason: `Attempt ${entry.attempt} · ${entry.error ?? 'continuing'}`,
  ranking: null,
  blockers: [],
  unlocks: issue?.unlocks ?? 0,
  hasDetail: inspectable.has(entry.issue_identifier),
  queueReason: null,
  finishedAt: null,
  pullRequestUrl: null,
  action: 'pause',
})

/**
 * Work an agent finished that has not reached the remote. It is progress rather than attention:
 * the change exists, the host is retrying the publication, and an operator has nothing to do until
 * those attempts are spent — at which point the issue goes back to the agent as an ordinary retry.
 */
const deliveringItem = (
  entry: DeliveringEntry,
  issue: BacklogIssue | undefined,
  paused: ReadonlySet<number>,
  inspectable: ReadonlySet<string>,
): WorkItem => {
  const issueNumber = issue?.number ?? issueNumberOf(entry.issue_identifier)
  // Read from the row's own issue number when the backlog no longer carries the issue. A delivery
  // outlives its issue's presence there — an issue that closes while its work is held leaves the
  // backlog, and asking the backlog whether it is paused would answer only that it is gone, which
  // is what left the row offering a pause that had already happened and no way back.
  const eligibility =
    issue === undefined && issueNumber !== null && paused.has(issueNumber)
      ? 'paused'
      : eligibilityOf(issue, paused)
  return {
    identifier: entry.issue_identifier,
    issueNumber,
    title: entry.title,
    url: entry.issue_url,
    state: 'progress',
    attention: null,
    phase: 'delivering',
    eligibility,
    priority: issue?.priority ?? null,
    labels: issue?.labels ?? [],
    reason: `Publishing to ${entry.branch_name} failed (${entry.category}) · ${entry.reason}`,
    ranking: null,
    blockers: [],
    unlocks: issue?.unlocks ?? 0,
    hasDetail: inspectable.has(entry.issue_identifier),
    queueReason: null,
    finishedAt: null,
    pullRequestUrl: null,
    // A pause suspends a delivery rather than dropping it, so the row an operator sees while one is
    // held has to offer the way back: without a resume here the timer is never re-armed and the
    // retained change waits on an API call by hand.
    action: eligibility === 'paused' ? 'start' : 'pause',
  }
}

const handoffAttention = (phase: PipelinePhase): AttentionKind | null => {
  if (phase === 'repair_needed') {
    return 'repair_needed'
  }
  if (phase === 'intervention_required' || phase === 'closed_without_merge') {
    return 'intervention_required'
  }
  return null
}

const handoffItem = (
  entry: HandoffEntry,
  issue: BacklogIssue | undefined,
  paused: ReadonlySet<number>,
  inspectable: ReadonlySet<string>,
  now: number,
): WorkItem => {
  const phase = handoffPhases[entry.state] ?? 'handing_off'
  const attention = handoffAttention(phase)
  const merged = phase === 'merged'
  const state: WorkState = attention !== null ? 'attention' : merged ? 'finished' : 'progress'
  const notDispatchable = ineligibilityReason(issue, paused)
  const handoffReason = entry.reason ?? `Head ${entry.head_sha ?? 'pending'}`
  return {
    identifier: entry.issue_identifier,
    issueNumber: issueNumberOf(entry.issue_identifier),
    title: issue?.title ?? entry.issue_identifier,
    url: issue?.url ?? null,
    state,
    attention,
    phase,
    eligibility: eligibilityOf(issue, paused),
    priority: issue?.priority ?? null,
    labels: issue?.labels ?? [],
    reason:
      notDispatchable === null
        ? handoffReason
        : `${handoffReason} Not dispatchable: ${notDispatchable}.`,
    ranking: attention === null ? null : attentionRanking(attention, issue?.priority ?? null),
    blockers: issue === undefined ? [] : blockerList(issue),
    unlocks: issue?.unlocks ?? 0,
    // A handoff restored from the store after a restart has no agent session behind it, so it gets
    // its pull request and nothing to inspect.
    hasDetail: inspectable.has(entry.issue_identifier),
    queueReason: null,
    finishedAt: merged ? new Date(now).toISOString() : null,
    pullRequestUrl: entry.pull_request_url,
    action: 'none',
  }
}

const completedItem = (entry: CompletedEntry, inspectable: ReadonlySet<string>): WorkItem => ({
  identifier: entry.issue_identifier,
  issueNumber: issueNumberOf(entry.issue_identifier),
  title: entry.title,
  url: entry.issue_url,
  state: 'finished',
  attention: null,
  phase: 'merged',
  eligibility: 'not_eligible',
  priority: null,
  labels: [],
  reason: 'Merged and closed out.',
  ranking: null,
  blockers: [],
  unlocks: 0,
  // A session whose timeline is still retained answers with a post-mortem, and finished work is
  // exactly where an operator goes looking for one.
  hasDetail: inspectable.has(entry.issue_identifier),
  queueReason: null,
  finishedAt: entry.finished_at,
  pullRequestUrl: entry.pull_request_url,
  action: 'none',
})

/**
 * Which dispatch limit stops this issue starting immediately, if either does. The scheduler
 * enforces a global limit and an optional per-state one, and an operator told "Start agent" for
 * work that will sit in a queue has been told the wrong thing.
 */
const bindingLimit = (
  issue: BacklogIssue,
  capacity: WorkModel['capacity'],
  saturated: ReadonlySet<string>,
): string | null => {
  if (!capacity.known) {
    // Absent the runtime snapshot the host may be full, or this issue's state may be saturated.
    // Promising an immediate start would be a guess, and the honest answer is that it is queued.
    return 'Sloppenheimer’s runtime state has not loaded, so a free dispatch slot cannot be confirmed'
  }
  if (capacity.full) {
    return `Sloppenheimer is at capacity (${capacity.running} of ${capacity.limit} agents)`
  }
  if (saturated.has(issue.normalizedState)) {
    return `issues in state “${issue.state}” have reached their own concurrency limit`
  }
  return null
}

const backlogItem = (
  issue: BacklogIssue,
  capacity: WorkModel['capacity'],
  saturated: ReadonlySet<string>,
  paused: ReadonlySet<number>,
): WorkItem => {
  const blockers = blockerList(issue)
  const cyclic = issue.readiness === 'cyclic'
  const blocked = issue.readiness === 'blocked'
  const escalated = blocked && issue.priority !== null && issue.priority <= escalatedPriority
  const attention: AttentionKind | null = cyclic ? 'cycle' : escalated ? 'blocked_priority' : null
  const state: WorkState =
    attention !== null ? 'attention' : issue.readiness === 'ready' ? 'ready' : 'blocked'
  const eligibility = eligibilityOf(issue, paused)
  const queueReason = bindingLimit(issue, capacity, saturated)
  const action: ActionKind =
    state === 'ready'
      ? eligibility === 'eligible'
        ? 'pause'
        : queueReason === null
          ? 'start'
          : 'queue'
      : 'blockers'
  return {
    identifier: issue.identifier,
    issueNumber: issue.number,
    title: issue.title,
    url: issue.url,
    state,
    attention,
    phase: cyclic ? 'cyclic' : blocked ? 'blocked' : 'dispatchable',
    eligibility,
    priority: issue.priority,
    labels: issue.labels,
    reason: issue.reason ?? blockerSummary(blockers),
    ranking: attention === null ? null : attentionRanking(attention, issue.priority),
    blockers,
    unlocks: issue.unlocks,
    hasDetail: false,
    queueReason: action === 'queue' ? queueReason : null,
    finishedAt: null,
    pullRequestUrl: null,
    action,
  }
}
