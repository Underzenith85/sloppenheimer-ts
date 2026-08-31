import { unresolvedBlockers } from '../domain/dependencies.js'
import { normalizeState, type Issue, type IssueId } from '../domain/domain.js'
import type { Workflow } from '../config/workflow.js'
import type { EffectiveWorkflow, ExecutionSnapshot, RunningEntry, RuntimeState } from './state.js'

/**
 * The scheduler's decisions about a single issue, as pure functions of the issue, the workflow, and
 * the state as it stands. Nothing here reads a fiber, performs an effect, or edits anything: each
 * answers one question the event loop asks before it acts.
 */

export const stateIsIn = (state: string, configured: readonly string[]): boolean => {
  const normalized = normalizeState(state)
  return configured.some((candidate) => normalizeState(candidate) === normalized)
}

export const issueIsActive = (issue: Issue, workflow: Workflow): boolean =>
  stateIsIn(issue.state, workflow.config.tracker.activeStates) &&
  !stateIsIn(issue.state, workflow.config.tracker.terminalStates)

export const issueIsRoutable = (issue: Issue, workflow: Workflow): boolean => {
  if (!issue.dispatchable) {
    return false
  }
  if (unresolvedBlockers(issue, workflow.config.tracker.terminalStates).length > 0) {
    return false
  }
  const labels = new Set(issue.labels.map((label) => label.trim().toLowerCase()))
  return workflow.config.tracker.requiredLabels.every(
    (label) => label.length > 0 && labels.has(label),
  )
}

export const issueIsActiveInSnapshot = (issue: Issue, snapshot: ExecutionSnapshot): boolean =>
  stateIsIn(issue.state, snapshot.activeStates) && !stateIsIn(issue.state, snapshot.terminalStates)

export const issueIsRoutableInSnapshot = (issue: Issue, snapshot: ExecutionSnapshot): boolean => {
  if (!issue.dispatchable) {
    return false
  }
  if (unresolvedBlockers(issue, snapshot.terminalStates).length > 0) {
    return false
  }
  const labels = new Set(issue.labels.map((label) => label.trim().toLowerCase()))
  return snapshot.requiredLabels.every((label) => label.length > 0 && labels.has(label))
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
      reason: 'recovering' | 'claimed' | 'paused' | 'cyclic' | 'inactive' | 'unroutable' | 'no_slot'
    }>

export const identifierIssueNumber = (identifier: string): number | null => {
  const match = /#(\d+)$/u.exec(identifier)
  return match?.[1] === undefined ? null : Number(match[1])
}

/**
 * Whether the poll loop dispatches this candidate, and if not, which rule refused it. The order is
 * the order the event loop applied inline before this was a function, and it is significant:
 * startup recovery gates everything, and a claim is checked before the costlier predicates.
 */
export const dispatchAdmission = (
  state: RuntimeState,
  issue: Issue,
  workflow: Workflow,
  cyclicIdentifiers: ReadonlySet<string>,
): DispatchAdmission => {
  if (!state.startupRecoveryFinished) {
    return { _tag: 'Refuse', reason: 'recovering' }
  }
  if (state.claimed.has(issue.id)) {
    return { _tag: 'Refuse', reason: 'claimed' }
  }
  const issueNumber = identifierIssueNumber(issue.identifier)
  if (issueNumber !== null && state.pausedIssueNumbers.has(issueNumber)) {
    return { _tag: 'Refuse', reason: 'paused' }
  }
  if (cyclicIdentifiers.has(issue.identifier)) {
    return { _tag: 'Refuse', reason: 'cyclic' }
  }
  if (!issueIsActive(issue, workflow)) {
    return { _tag: 'Refuse', reason: 'inactive' }
  }
  if (!issueIsRoutable(issue, workflow)) {
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
): boolean => identifierIssueNumber(entry.issue.identifier) === issueNumber

export const captureExecutionSnapshot = (
  effective: EffectiveWorkflow,
  prompt: string,
): ExecutionSnapshot => ({
  workflow: effective.workflow,
  tracker: effective.tracker,
  codeReview: effective.codeReview,
  requiredLabels: [...effective.workflow.config.tracker.requiredLabels],
  activeStates: [...effective.workflow.config.tracker.activeStates],
  terminalStates: [...effective.workflow.config.tracker.terminalStates],
  secretEnvironmentNames: [...effective.tracker.secretEnvironmentNames],
  workspaces: effective.workspaces,
  workspaceRoot: effective.workflow.config.workspaceRoot,
  prompt,
  agentRunner: { ...effective.workflow.config.codex },
  maxTurns: effective.workflow.config.agent.maxTurns,
  stallTimeoutMs: effective.workflow.config.codex.stallTimeoutMs,
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

export const retryDelayMs = (attempt: number, maximumMs: number): number =>
  Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), maximumMs)

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
