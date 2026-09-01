/**
 * Which handoffs a pass may act on, and how far.
 *
 * Kept apart from the reconciliation itself so that "may this handoff be touched at all", "may a
 * repair be dispatched for it", and "what does the observation say" are three separate questions
 * with three separate answers. The first two are policy about the issue and its workspace; the
 * third is the state machine in `handoff-decision.ts`.
 */

import { Effect, Option } from 'effect'

import type { Issue, IssueId } from '../domain/domain.js'
import { identifierIssueNumber, issueIsActive, issueIsRoutable, stateIsIn } from './policy.js'
import type { HandoffEntry, RuntimeState } from './state.js'

/**
 * Whether something looked at this issue's workspace for unpublished work and could not say.
 *
 * Deliberately not "has never been looked at": a handoff outlives its issue's presence in the
 * candidate fetch, and a repair that waited for an examination that will never come would never
 * happen. A pass that could not look at all refuses repair dispatch wholesale instead, through the
 * permission the poll already carries.
 */
export const workspaceUnexamined = (state: RuntimeState, id: IssueId): boolean =>
  state.unexaminedWorkspaces.has(id)

/** Whether this handoff is the orchestrator's to act on at all in this pass. */
export const skipped = (state: RuntimeState, id: IssueId, handoff: HandoffEntry): boolean => {
  // A retained delivery is work this pull request has not seen yet. Observing the head while it
  // waits would read the pre-delivery state as the repair's output, which is the reading this
  // whole separation exists to prevent.
  if (state.running.has(id) || state.retries.has(id) || state.deliveries.has(id)) {
    return true
  }
  if (handoff.state === 'closed_without_merge') {
    return true
  }
  return Option.exists(identifierIssueNumber(handoff.issue.identifier), (issueNumber) =>
    state.pausedIssueNumbers.has(issueNumber),
  )
}

export type IssueRefresh =
  | Readonly<{ _tag: 'Failed'; reason: string }>
  | Readonly<{ _tag: 'Succeeded'; issue: Option.Option<Issue> }>

export type RepairPermission =
  | Readonly<{ _tag: 'Allowed'; issue: Issue }>
  | Readonly<{ _tag: 'Denied'; reason: string }>

/**
 * A handoff keeps the workflow that created its pull request. A freshly fetched issue is evaluated
 * against that same workflow before new agent work starts, while review and merge observation stay
 * independent of issue eligibility. Removing a label therefore stops repairs without stranding a
 * pull request that is already green.
 */
export const repairPermission = (
  handoff: HandoffEntry,
  refresh: IssueRefresh,
): RepairPermission => {
  if (refresh._tag === 'Failed') {
    return { _tag: 'Denied', reason: `Cannot confirm repair eligibility. ${refresh.reason}` }
  }
  if (Option.isNone(refresh.issue)) {
    return {
      _tag: 'Denied',
      reason: 'Repair paused because the tracker no longer reports the issue.',
    }
  }
  const issue = refresh.issue.value
  const workflow = handoff.execution.workflow
  if (stateIsIn(issue.state, workflow.config.tracker.terminalStates)) {
    return { _tag: 'Denied', reason: 'Repair paused because the issue is terminal.' }
  }
  if (
    !issueIsActive(issue, workflow.config.tracker) ||
    !issueIsRoutable(issue, workflow.config.tracker)
  ) {
    return {
      _tag: 'Denied',
      reason: 'Repair paused because the issue is not eligible under its handoff workflow.',
    }
  }
  return { _tag: 'Allowed', issue }
}

/**
 * Refresh each eligible handoff independently.
 *
 * The tracker boundary is fail-fast even when it accepts several IDs, so batching unrelated
 * handoffs would let one malformed or missing tracker record deny repairs for every pull request
 * in that batch. Eligibility refreshes are deliberately isolated here: a provider failure can
 * affect only the handoff whose policy decision depends on it.
 */
export const refreshHandoffIssues = (
  handoffs: ReadonlyMap<IssueId, HandoffEntry>,
): Effect.Effect<ReadonlyMap<IssueId, IssueRefresh>, never> =>
  Effect.gen(function* () {
    const fetched: readonly (readonly [IssueId, IssueRefresh])[] = yield* Effect.forEach(
      handoffs,
      ([id, handoff]) =>
        handoff.execution.tracker.fetchIssuesByIds([id]).pipe(
          Effect.match({
            onFailure: (error) =>
              [id, { _tag: 'Failed', reason: error.message } satisfies IssueRefresh] as const,
            onSuccess: (issues) =>
              [
                id,
                {
                  _tag: 'Succeeded',
                  issue: Option.fromNullable(issues.find((issue) => issue.id === id)),
                } satisfies IssueRefresh,
              ] as const,
          }),
        ),
    )
    return new Map(fetched)
  })
