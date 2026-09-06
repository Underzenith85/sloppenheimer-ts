import { Option } from 'effect'

import type { IssueId } from '../../domain/domain.js'
import { withEntry, withoutEntry, withMember, withoutMember } from '../../support/collections.js'
import type { RetryEntry, RuntimeState } from '../state.js'
import { noteIssue } from './claims.js'

/**
 * The queued retry projections and operator pause list. Durable workflow state owns admission.
 */

/**
 * Queues a retry. An issue has at most one pending retry: a newer schedule always wins, and the
 * timer it displaces is interrupted by the execution owner the new one is armed under.
 */
export const scheduleRetry = (state: RuntimeState, entry: RetryEntry): RuntimeState => {
  const noted = noteIssue(state, entry.issue)
  return { ...noted, retries: withEntry(noted.retries, entry.issue.id, entry) }
}

/** Removes a queued retry, returning it so the caller can release its timer. */
export const takeRetry = (
  state: RuntimeState,
  id: IssueId,
): readonly [Option.Option<RetryEntry>, RuntimeState] => {
  const entry = state.retries.get(id)
  if (entry === undefined) {
    return [Option.none(), state]
  }
  return [Option.some(entry), { ...state, retries: withoutEntry(state.retries, id) }]
}

/**
 * Takes a retry only when it is the attempt that came due. A `RetryDue` for a superseded attempt
 * belongs to a timer that has since been replaced, and must not consume the live one.
 */
export const takeDueRetry = (
  state: RuntimeState,
  id: IssueId,
  attempt: number,
): readonly [Option.Option<RetryEntry>, RuntimeState] => {
  const entry = state.retries.get(id)
  if (entry?.attempt !== attempt) {
    return [Option.none(), state]
  }
  return [Option.some(entry), { ...state, retries: withoutEntry(state.retries, id) }]
}

/** The operator's pause list, by issue number: a paused number dispatches nothing. */
export const pauseIssueNumber = (state: RuntimeState, issueNumber: number): RuntimeState => ({
  ...state,
  pausedIssueNumbers: withMember(state.pausedIssueNumbers, issueNumber),
})

export const resumeIssueNumber = (state: RuntimeState, issueNumber: number): RuntimeState => ({
  ...state,
  pausedIssueNumbers: withoutMember(state.pausedIssueNumbers, issueNumber),
})
