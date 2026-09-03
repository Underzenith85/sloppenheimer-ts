import { Option } from 'effect'

import { normalizeState, type Issue, type IssueId } from '../domain/domain.js'
import type { Workflow } from '../config/workflow.js'
import type { EffectiveWorkflow, ExecutionSnapshot, RunningEntry, RuntimeState } from './state.js'

/**
 * The scheduler's decisions about a single issue, as pure functions of the issue, the workflow, and
 * the state as it stands. Nothing here reads a fiber, performs an effect, or edits anything: each
 * answers one question the event loop asks before it acts.
 */

/**
 * The instant a live run counts as stalled, or `None` while its stall detection is off.
 *
 * The stall timer measures silence on the agent protocol, so its clock runs only while there is an
 * agent to be silent: it starts when the host launches the runner, moves with every protocol event,
 * and stops when the host's postflight takes the run over. Before the launch the run is the host's
 * — a workspace lease and its hook, a clone and base-branch fetch, the `before_run` hook — and
 * measured from dispatch, a fetch that outlasts the timeout was retired as a stalled agent and
 * retried into another empty workspace, never to succeed. After the takeover no agent is running,
 * and a slow publication is the source control's to fail, as a delivery. A zero timeout disables
 * detection outright. The stall sweep, the running snapshot and the agent detail all read this one
 * rule, so no surface can report a stall the sweep would never act on.
 */
export const stallDeadlineOf = (entry: RunningEntry): Option.Option<Date> => {
  const activeAt = entry.lastEventAt ?? entry.agentStartedAt
  const stallTimeoutMs = entry.execution.stallTimeoutMs
  return activeAt === null || stallTimeoutMs <= 0 || entry.postflightStartedAt !== null
    ? Option.none()
    : Option.some(new Date(activeAt.getTime() + stallTimeoutMs))
}

export const stateIsIn = (state: string, configured: readonly string[]): boolean => {
  const normalized = normalizeState(state)
  return configured.some((candidate) => normalizeState(candidate) === normalized)
}

/**
 * What an issue's eligibility is judged against.
 *
 * The workflow in force and the snapshot a run captured are two sources for the same fields, and
 * the predicates below need nothing else from either. Naming just those fields is what lets one
 * implementation serve both: `TrackerConfig` and `ExecutionSnapshot` each satisfy these
 * structurally, so a caller passes whichever it is holding and no adapter is needed.
 *
 * They are two types rather than one because the predicates ask separate questions: a caller that
 * only has required labels to apply should not have to invent the state lists to say so.
 */
export type RoutingRules = Readonly<{ requiredLabels: readonly string[] }>
export type ActivityRules = Readonly<{
  activeStates: readonly string[]
  terminalStates: readonly string[]
}>

/**
 * A label as it is compared: trimmed and lowercased, so matching is case- and whitespace-
 * insensitive. Applied to *both* sides of the comparison — a required label is normalized here
 * rather than assumed to have been normalized by whoever configured it, because the two sources of
 * these rules do not agree on that. The workflow loader lowercases `required_labels` on the way in;
 * an `ExecutionSnapshot` copies whatever it was given.
 */
const comparableLabel = (label: string): string => label.trim().toLowerCase()

export const issueIsActive = (issue: Issue, rules: ActivityRules): boolean =>
  stateIsIn(issue.state, rules.activeStates) && !stateIsIn(issue.state, rules.terminalStates)

export const issueIsRoutable = (issue: Issue, rules: RoutingRules): boolean => {
  if (!issue.dispatchable) {
    return false
  }
  const labels = new Set(issue.labels.map(comparableLabel))
  // An empty required label is a misconfiguration no issue can satisfy, and it refuses the
  // dispatch rather than being skipped: a gate that cannot be met must not read as met.
  return rules.requiredLabels
    .map(comparableLabel)
    .every((label) => label.length > 0 && labels.has(label))
}

/**
 * Whether an agent slot is free for this issue: one budget across all runs, and a second budget for
 * runs in the issue's own tracker state.
 */
export const hasSlot = (state: RuntimeState, issue: Issue, workflow: Workflow): boolean => {
  if (state.running.size >= workflow.config.agent.maxConcurrentAgents) {
    return false
  }
  const normalized = normalizeState(issue.state)
  const limit =
    workflow.config.agent.maxConcurrentAgentsByState.get(normalized) ??
    workflow.config.agent.maxConcurrentAgents
  const used = [...state.running.values()].filter(
    (entry) => normalizeState(entry.issue.state) === normalized,
  ).length
  return used < limit
}

/**
 * Why a polled candidate is not dispatched, or that it is.
 *
 * The reason is named rather than reduced to a boolean because it is the scheduler's entire
 * admission policy in one value: a test can assert which rule refused a candidate, and an
 * unexpected refusal is legible instead of silent.
 */
export type DispatchAdmission =
  | Readonly<{ _tag: 'Admit' }>
  | Readonly<{
      _tag: 'Refuse'
      reason: 'recovering' | 'claimed' | 'paused' | 'inactive' | 'unroutable' | 'no_slot'
    }>

/** The issue number an identifier ends in, when it carries one at all. */
export const identifierIssueNumber = (identifier: string): Option.Option<number> => {
  const match = /#(\d+)$/u.exec(identifier)
  return match?.[1] === undefined ? Option.none() : Option.some(Number(match[1]))
}

/**
 * Whether the operator's pause list names this issue.
 *
 * Asked by every path that can put an agent on an issue — the poll, a due retry, a due delivery, a
 * handoff pass, and the dispatch itself — because a pause is read at the moment something would
 * dispatch, not only at the moment it lands. A retry can be queued after the pause: the
 * publication a pause deliberately leaves to finish schedules a continuation when it settles, and
 * that continuation coming due is the moment the pause has to be read again.
 */
export const issueIsPaused = (state: RuntimeState, issue: Issue): boolean =>
  Option.exists(identifierIssueNumber(issue.identifier), (issueNumber) =>
    state.pausedIssueNumbers.has(issueNumber),
  )

/**
 * Whether the poll loop dispatches this candidate, and if not, which rule refused it. The order is
 * the order the event loop applied inline before this was a function, and it is significant:
 * startup recovery gates everything, and a claim is checked before the costlier predicates.
 */
export const dispatchAdmission = (
  state: RuntimeState,
  issue: Issue,
  workflow: Workflow,
): DispatchAdmission => {
  if (!state.startupRecoveryFinished) {
    return { _tag: 'Refuse', reason: 'recovering' }
  }
  if (state.claimed.has(issue.id)) {
    return { _tag: 'Refuse', reason: 'claimed' }
  }
  if (issueIsPaused(state, issue)) {
    return { _tag: 'Refuse', reason: 'paused' }
  }
  if (!issueIsActive(issue, workflow.config.tracker)) {
    return { _tag: 'Refuse', reason: 'inactive' }
  }
  if (!issueIsRoutable(issue, workflow.config.tracker)) {
    return { _tag: 'Refuse', reason: 'unroutable' }
  }
  if (!hasSlot(state, issue, workflow)) {
    return { _tag: 'Refuse', reason: 'no_slot' }
  }
  return { _tag: 'Admit' }
}

/** Whether a paused issue number belongs to this entry's issue. */
export const entryMatchesIssueNumber = (
  entry: Readonly<{ issue: Issue }>,
  issueNumber: number,
): boolean =>
  Option.exists(identifierIssueNumber(entry.issue.identifier), (each) => each === issueNumber)

export const captureExecutionSnapshot = (
  effective: EffectiveWorkflow,
  prompt: string,
): ExecutionSnapshot => ({
  workflow: effective.workflow,
  tracker: effective.tracker,
  codeReview: effective.codeReview,
  sourceControl: effective.sourceControl,
  requiredLabels: [...effective.workflow.config.tracker.requiredLabels],
  activeStates: [...effective.workflow.config.tracker.activeStates],
  terminalStates: [...effective.workflow.config.tracker.terminalStates],
  secretEnvironmentNames: [...effective.tracker.secretEnvironmentNames],
  workspaces: effective.workspaces,
  workspaceRoot: effective.workflow.config.workspaceRoot,
  prompt,
  // The neutral half comes from the configuration, the opaque half from the validated selection:
  // together they are everything the launch hands the adapter that owns the kind.
  agentRunner: {
    ...effective.workflow.config.runner,
    settings: effective.workflow.runner.settings,
  },
  maxTurns: effective.workflow.config.agent.maxTurns,
  stallTimeoutMs: effective.workflow.config.runner.stallTimeoutMs,
})

export const sortIssues = (issues: readonly Issue[]): readonly Issue[] =>
  [...issues].sort((left, right) => {
    const leftPriority =
      left.priority !== null && left.priority >= 1 && left.priority <= 4 ? left.priority : 5
    const rightPriority =
      right.priority !== null && right.priority >= 1 && right.priority <= 4 ? right.priority : 5
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority
    }
    const leftCreated = left.createdAt?.getTime() ?? Number.POSITIVE_INFINITY
    const rightCreated = right.createdAt?.getTime() ?? Number.POSITIVE_INFINITY
    if (leftCreated !== rightCreated) {
      return leftCreated - rightCreated
    }
    return left.identifier.localeCompare(right.identifier)
  })

export const logContext = (issue: Issue): Readonly<Record<string, string>> => ({
  issue_id: issue.id,
  issue_identifier: issue.identifier,
})

export const sessionLogContext = (
  entry: RunningEntry,
): Readonly<Record<string, string | number | null>> => ({
  ...logContext(entry.issue),
  session_id: entry.sessionId,
  thread_id: entry.threadId,
  turn_id: entry.turnId,
  turn_count: entry.turnCount,
})

/** The issues a paused issue number reaches, in either phase the pause has to end. */
export const issuesForNumber = (
  entries: ReadonlyMap<IssueId, Readonly<{ issue: Issue }>>,
  issueNumber: number,
): readonly IssueId[] =>
  [...entries].filter(([, entry]) => entryMatchesIssueNumber(entry, issueNumber)).map(([id]) => id)
