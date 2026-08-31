// The console's view model. It is pure: given a runtime snapshot, a backlog snapshot and the
// current instant it answers the four questions the operator actually asks — what needs attention,
// what is ready, what is running, and what finished — without touching the DOM. Classification and
// ranking live here so they can be reasoned about, and tested, apart from rendering.

// The console reads `/api/v1/state`, so it is written against the published document rather than
// against the runtime's internal snapshot: the fields are the ones SPEC 13.7.2 names.
type PublishedState = import('../api.js').PublishedState
type BacklogSnapshot = import('../operator.js').BacklogSnapshot
type BacklogIssue = BacklogSnapshot['issues'][number]
type RunningEntry = PublishedState['running'][number]
type RetryingEntry = PublishedState['retrying'][number]
type HandoffEntry = PublishedState['handoffs'][number]
type CompletedEntry = PublishedState['completed'][number]

/**
 * The primary placement of one piece of work. Every item has exactly one, and it is kept apart
 * from the attention condition, the pipeline phase and orchestration eligibility below, so that a
 * repair-needed pull request can be reported as needing attention without losing the fact that it
 * is a pull request awaiting a fix.
 */
type WorkState = 'attention' | 'ready' | 'blocked' | 'progress' | 'finished'

/** Why an item is operator-actionable, as opposed to merely waiting on a dependency. */
type AttentionKind =
  | 'stalled'
  | 'intervention_required'
  | 'repair_needed'
  | 'cycle'
  | 'recovery_failed'
  | 'blocked_priority'

/** Where the item sits in the execution pipeline. Orthogonal to {@link WorkState}. */
type PipelinePhase =
  | 'starting'
  | 'running'
  | 'retrying'
  | 'handing_off'
  | 'awaiting_checks'
  | 'ready_to_merge'
  | 'merging'
  | 'repair_needed'
  | 'intervention_required'
  | 'closed_without_merge'
  | 'merged'
  | 'dispatchable'
  | 'blocked'
  | 'cyclic'

/**
 * Whether Symphony may select this issue, independent of whether anything is running for it.
 * `paused` is an operator decision that can be undone here; `not_eligible` means the issue simply
 * does not carry the orchestration label yet. Collapsing the two would make the console unable to
 * say which of them it is about to change.
 */
type Eligibility = 'eligible' | 'paused' | 'not_eligible'

/**
 * What the primary control on a row does. The names match the backend contract rather than the
 * orchestral metaphor: enabling an issue makes it eligible and asks Symphony to reselect, which is
 * an immediate start only when there is spare capacity.
 */
type ActionKind = 'start' | 'queue' | 'pause' | 'blockers' | 'none'

type Blocker = Readonly<{ identifier: string; url: string | null }>

type WorkItem = Readonly<{
  identifier: string
  issueNumber: number | null
  title: string
  url: string | null
  state: WorkState
  attention: AttentionKind | null
  phase: PipelinePhase
  eligibility: Eligibility
  priority: number | null
  labels: readonly string[]
  /** Why the item sits where it does, in the operator's words. */
  reason: string | null
  /** Why the item is ranked where it is within its queue. */
  ranking: string | null
  blockers: readonly Blocker[]
  unlocks: number
  /** Whether an agent session exists to inspect behind this row. */
  hasDetail: boolean
  /**
   * Which dispatch limit is currently binding for this issue, when one is. It is what the row says
   * after a queue request, so the operator is told why the work did not start rather than only
   * that it did not.
   */
  queueReason: string | null
  finishedAt: string | null
  pullRequestUrl: string | null
  action: ActionKind
}>

/** A host-level exception that belongs to no single issue. */
type SystemAlert = Readonly<{
  key: string
  title: string
  detail: string
}>

type WorkModel = Readonly<{
  attention: readonly WorkItem[]
  ready: readonly WorkItem[]
  blocked: readonly WorkItem[]
  progress: readonly WorkItem[]
  finished: readonly WorkItem[]
  alerts: readonly SystemAlert[]
  counts: Readonly<{ attention: number; ready: number; progress: number; finished: number }>
  /**
   * Dispatch capacity as the console currently knows it. `known` is false until the runtime
   * snapshot arrives: the backlog and the runtime are fetched separately, so there is a window in
   * which the console knows what work exists but not whether anything could run.
   */
  capacity: Readonly<{ running: number; limit: number; full: boolean; known: boolean }>
}>

/** How far back Finished reaches. Stated once here and rendered as a label the tests can read. */
const finishedWindowMs = 24 * 60 * 60 * 1000
const finishedWindowLabel = 'last 24 hours'
/**
 * The full scope, which is a window *and* a lifetime: completions live in the running host's state,
 * so a restart empties the view even for work that merged inside the window. Saying so is the point
 * — a view that claimed a flat 24 hours would be claiming more than the host can know.
 */
const finishedScopeLabel = 'work this host finished in the last 24 hours; a restart clears it'

const workStateLabels: Readonly<Record<WorkState, string>> = {
  attention: 'Needs attention',
  ready: 'Ready',
  blocked: 'Blocked',
  progress: 'In progress',
  finished: 'Finished',
}

const attentionLabels: Readonly<Record<AttentionKind, string>> = {
  stalled: 'Agent stalled',
  intervention_required: 'Needs intervention',
  repair_needed: 'Repair needed',
  cycle: 'Dependency cycle',
  recovery_failed: 'Recovery failed',
  blocked_priority: 'High-priority blocked',
}

const phaseLabels: Readonly<Record<PipelinePhase, string>> = {
  starting: 'Starting',
  running: 'Running',
  retrying: 'Retrying',
  handing_off: 'Handing off',
  awaiting_checks: 'Awaiting checks',
  ready_to_merge: 'Ready to merge',
  merging: 'Merging',
  repair_needed: 'Repair needed',
  intervention_required: 'Needs intervention',
  closed_without_merge: 'Closed without merge',
  merged: 'Merged',
  dispatchable: 'Dispatchable',
  blocked: 'Blocked',
  cyclic: 'Cyclic',
}

const eligibilityLabels: Readonly<Record<Eligibility, string>> = {
  eligible: 'Eligible',
  paused: 'Paused',
  not_eligible: 'Not eligible',
}

/** Most urgent first. A stalled agent is burning capacity now; a cycle will still be there later. */
const attentionOrder: readonly AttentionKind[] = [
  'stalled',
  'intervention_required',
  'repair_needed',
  'recovery_failed',
  'cycle',
  'blocked_priority',
]

const handoffPhases: Readonly<Record<string, PipelinePhase>> = {
  awaiting_checks: 'awaiting_checks',
  repair_needed: 'repair_needed',
  ready_to_merge: 'ready_to_merge',
  merging: 'merging',
  closed_without_merge: 'closed_without_merge',
  intervention_required: 'intervention_required',
  merged: 'merged',
}

/** Issues at or above this priority are an exception when blocked rather than ordinary waiting. */
const escalatedPriority = 1

const issueNumberOf = (identifier: string): number | null => {
  const match = /#(\d+)$/u.exec(identifier)
  return match?.[1] === undefined ? null : Number(match[1])
}

/**
 * Orders two numbers a row may not carry, absent last.
 *
 * Both the priority and the issue number are optional on a work item, and in each case an item
 * without one sorts below every item that has one — a row with no priority is not "priority zero",
 * and a row whose identifier carries no number has nothing to tie-break on. One comparator serves
 * both because that is the whole of the rule.
 */
const compareOptionalNumber = (left: number | null, right: number | null): number => {
  if (left === right) {
    return 0
  }
  if (left === null) {
    return 1
  }
  if (right === null) {
    return -1
  }
  return left - right
}

/** The position of a value in a fixed ordering, for the columns ranked by a named sequence. */
const compareRank = <Value>(order: readonly Value[], left: Value, right: Value): number =>
  order.indexOf(left) - order.indexOf(right)

/**
 * The first comparator that separates the two rows, or zero when none does.
 *
 * Every ordering below is a sequence of tie-breaks read in order, and writing that out by hand is
 * what made three of them the same shape with different names in the middle. Stating the sequence
 * as a list keeps each ordering readable as the rule it is.
 */
const inOrder =
  <Value>(...comparators: readonly ((left: Value, right: Value) => number)[]) =>
  (left: Value, right: Value): number => {
    for (const compare of comparators) {
      const result = compare(left, right)
      if (result !== 0) {
        return result
      }
    }
    return 0
  }

/** The deterministic tie-break every queue ends with, so one snapshot always sorts one way. */
const byIssueNumber = (left: WorkItem, right: WorkItem): number =>
  compareOptionalNumber(left.issueNumber, right.issueNumber)

const byPriority = (left: WorkItem, right: WorkItem): number =>
  compareOptionalNumber(left.priority, right.priority)

const priorityLabel = (priority: number | null): string =>
  priority === null ? 'no priority' : 'P' + String(priority)

const unlockLabel = (unlocks: number): string =>
  unlocks === 1 ? 'unlocks 1 issue' : 'unlocks ' + String(unlocks) + ' issues'

/**
 * Why a ready issue holds its place in the queue. Every ready row carries one, so the ordering is
 * self-explanatory rather than something the operator has to reverse-engineer from the labels.
 */
const readyRanking = (item: WorkItem, first: boolean): string =>
  priorityLabel(item.priority) +
  ' · ' +
  unlockLabel(item.unlocks) +
  (first ? ' · ranked first' : '')

const attentionRanking = (kind: AttentionKind, priority: number | null): string =>
  attentionLabels[kind] + ' · ' + priorityLabel(priority)

const blockerList = (issue: BacklogIssue): readonly Blocker[] =>
  issue.blockedBy.map((blocker) => ({ identifier: blocker.identifier, url: blocker.url }))

const blockerSummary = (blockers: readonly Blocker[]): string => {
  if (blockers.length === 0) {
    return 'No unresolved blockers'
  }
  const first = blockers[0]?.identifier ?? ''
  return blockers.length === 1
    ? 'Blocked by ' + first
    : 'Blocked by ' + first + ' and ' + String(blockers.length - 1) + ' more'
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
      detail: state.workflow_reload_error.message + ' — the last good workflow is still in force.',
    })
  }
  const recovery = state.handoff_recovery
  if (recovery.status === 'degraded' || recovery.failed > 0) {
    alerts.push({
      key: 'handoff-recovery',
      title: 'Handoff recovery is degraded',
      detail:
        String(recovery.failed) +
        ' of ' +
        String(recovery.loaded) +
        ' stored handoffs could not be recovered' +
        (recovery.store_error === null ? '.' : ': ' + recovery.store_error.message),
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
  reason: 'Attempt ' + String(entry.attempt) + ' · ' + (entry.error ?? 'continuing'),
  ranking: null,
  blockers: [],
  unlocks: issue?.unlocks ?? 0,
  hasDetail: inspectable.has(entry.issue_identifier),
  queueReason: null,
  finishedAt: null,
  pullRequestUrl: null,
  action: 'pause',
})

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
  const handoffReason = entry.reason ?? 'Head ' + (entry.head_sha ?? 'pending')
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
    return 'Symphony’s runtime state has not loaded, so a free dispatch slot cannot be confirmed'
  }
  if (capacity.full) {
    return (
      'Symphony is at capacity (' +
      String(capacity.running) +
      ' of ' +
      String(capacity.limit) +
      ' agents)'
    )
  }
  if (saturated.has(issue.normalizedState)) {
    return 'issues in state “' + issue.state + '” have reached their own concurrency limit'
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

const byAttention = inOrder<WorkItem>(
  (left, right) =>
    compareRank(
      attentionOrder,
      left.attention ?? 'blocked_priority',
      right.attention ?? 'blocked_priority',
    ),
  byPriority,
  byIssueNumber,
)

/**
 * The Ready ordering: priority first, then how much the issue unblocks, then the issue number as a
 * deterministic tie-break. Every comparison is total, so the same snapshot always produces the same
 * queue.
 */
const byReadiness = inOrder<WorkItem>(
  byPriority,
  // Descending: the issue that unblocks the most goes first.
  (left, right) => right.unlocks - left.unlocks,
  byIssueNumber,
)

const progressOrder: readonly PipelinePhase[] = [
  'starting',
  'running',
  'retrying',
  'handing_off',
  'awaiting_checks',
  'ready_to_merge',
  'merging',
]

const byProgress = inOrder<WorkItem>(
  (left, right) => compareRank(progressOrder, left.phase, right.phase),
  byIssueNumber,
)

const byFinished = (left: WorkItem, right: WorkItem): number => {
  const leftAt = left.finishedAt === null ? 0 : new Date(left.finishedAt).getTime()
  const rightAt = right.finishedAt === null ? 0 : new Date(right.finishedAt).getTime()
  return rightAt - leftAt
}

const emptyModel: WorkModel = {
  attention: [],
  ready: [],
  blocked: [],
  progress: [],
  finished: [],
  alerts: [],
  counts: { attention: 0, ready: 0, progress: 0, finished: 0 },
  capacity: { running: 0, limit: 0, full: false, known: false },
}

/**
 * Folds the two snapshots into one placement per item. Live runtime facts win over the backlog's
 * static readiness — an issue that is running is in progress whatever its labels say — and each
 * identifier is claimed exactly once, so no row can appear in two queues.
 */
const buildWorkModel = (
  state: PublishedState | null,
  backlog: BacklogSnapshot | null,
  now: number,
): WorkModel => {
  if (state === null && backlog === null) {
    return emptyModel
  }
  const issues = new Map((backlog?.issues ?? []).map((issue) => [issue.identifier, issue]))
  const claimed = new Set<string>()
  const items: WorkItem[] = []
  const claim = (item: WorkItem): void => {
    if (claimed.has(item.identifier)) {
      return
    }
    claimed.add(item.identifier)
    items.push(item)
  }
  const running = state?.running ?? []
  const limit = state?.max_concurrent_agents ?? 0
  const capacityFull = limit > 0 && running.length >= limit
  const paused = new Set(state?.paused_issue_numbers ?? [])
  const inspectable = new Set(state?.inspectable_agents ?? [])
  const saturated = new Set(state?.saturated_states ?? [])
  const capacity = { running: running.length, limit, full: capacityFull, known: state !== null }
  for (const entry of running) {
    claim(runningItem(entry, issues.get(entry.issue_identifier), paused, inspectable, now))
  }
  for (const entry of state?.retrying ?? []) {
    claim(retryingItem(entry, issues.get(entry.issue_identifier), paused, inspectable))
  }
  for (const entry of state?.handoffs ?? []) {
    claim(handoffItem(entry, issues.get(entry.issue_identifier), paused, inspectable, now))
  }
  for (const entry of state?.completed ?? []) {
    if (now - new Date(entry.finished_at).getTime() <= finishedWindowMs) {
      claim(completedItem(entry, inspectable))
    }
  }
  for (const issue of backlog?.issues ?? []) {
    claim(backlogItem(issue, capacity, saturated, paused))
  }
  const attention = items.filter((item) => item.state === 'attention').sort(byAttention)
  const ready = items.filter((item) => item.state === 'ready').sort(byReadiness)
  const blocked = items.filter((item) => item.state === 'blocked').sort(byReadiness)
  const progress = items.filter((item) => item.state === 'progress').sort(byProgress)
  const finished = items.filter((item) => item.state === 'finished').sort(byFinished)
  const alerts = systemAlerts(state)
  const explained = ready.map((item, index) => ({
    ...item,
    ranking: readyRanking(item, index === 0),
  }))
  return {
    attention,
    ready: explained,
    blocked,
    progress,
    finished,
    alerts,
    counts: {
      attention: attention.length + alerts.length,
      ready: explained.length,
      progress: progress.length,
      finished: finished.length,
    },
    capacity,
  }
}

/**
 * Which view opens by default. An actionable exception outranks anything else on the page; with
 * none, the operator is shown what they can dispatch.
 */
const defaultWorkView = (model: WorkModel): WorkState =>
  model.counts.attention > 0 ? 'attention' : 'ready'
