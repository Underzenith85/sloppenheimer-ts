import { Option } from 'effect'

import type { IssueId } from '../../domain/domain.js'
import { withEntry, withoutEntry, withMember, withoutMember } from '../../support/collections.js'
import type { RetryEntry, RuntimeState } from '../state.js'
import { claimIssue } from './claims.js'

/**
 * The queued retries, and the operator's pause list. A retry is a claim that has not been given up:
 * scheduling one claims the issue, and only the attempt that came due may take it back.
 */

/**
 * Queues a retry, returning whatever it displaced so the caller can interrupt that timer. An issue
 * has at most one pending retry: a newer schedule always wins.
 */
export const scheduleRetry = (
  state: RuntimeState,
  entry: RetryEntry,
): readonly [Option.Option<RetryEntry>, RuntimeState] => {
  const existing = Option.fromNullable(state.retries.get(entry.issue.id))
  const claimed = claimIssue(state, entry.issue)
  return [existing, { ...claimed, retries: withEntry(claimed.retries, entry.issue.id, entry) }]
}

/** Removes a queued retry, returning it so the caller can interrupt its timer. */
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
