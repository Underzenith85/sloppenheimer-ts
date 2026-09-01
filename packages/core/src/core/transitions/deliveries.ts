import { Option } from 'effect'

import type { IssueId } from '../../domain/domain.js'
import { withEntry, withoutEntry } from '../../support/collections.js'
import type { DeliveryEntry, RuntimeState } from '../state.js'
import { claimIssue } from './claims.js'

/**
 * Work waiting to reach the remote, and the retries queued for it.
 *
 * A delivery is shaped like a retry and is deliberately not one: it holds a claim with no worker
 * behind it, and what comes due is a publication rather than an agent. Keeping the two collections
 * apart is what lets a failed delivery be retried without the coding agent running again — and
 * what keeps the retry counter that governs agent backoff from counting publication attempts.
 */

/**
 * Queues a delivery, returning whatever it displaced so the caller can interrupt that timer. An
 * issue has at most one retained delivery: newer work supersedes older work in the same worktree.
 */
export const scheduleDelivery = (
  state: RuntimeState,
  entry: DeliveryEntry,
): readonly [Option.Option<DeliveryEntry>, RuntimeState] => {
  const existing = Option.fromNullable(state.deliveries.get(entry.issue.id))
  const claimed = claimIssue(state, entry.issue)
  return [
    existing,
    { ...claimed, deliveries: withEntry(claimed.deliveries, entry.issue.id, entry) },
  ]
}

/**
 * Takes a queued delivery only when it is the attempt that came due. A `DeliveryDue` for a
 * superseded attempt belongs to a timer that has since been replaced.
 */
export const takeDueDelivery = (
  state: RuntimeState,
  id: IssueId,
  attempt: number,
): readonly [Option.Option<DeliveryEntry>, RuntimeState] => {
  const entry = state.deliveries.get(id)
  if (entry?.attempt !== attempt) {
    return [Option.none(), state]
  }
  return [Option.some(entry), { ...state, deliveries: withoutEntry(state.deliveries, id) }]
}

/**
 * Drops a retained delivery whatever attempt it is on, returning it so the caller can interrupt
 * its timer. This is how work is abandoned rather than published: only a cancellation that
 * discards the workspace, per the documented policy, takes a delivery this way.
 */
export const takeDelivery = (
  state: RuntimeState,
  id: IssueId,
): readonly [Option.Option<DeliveryEntry>, RuntimeState] => {
  const entry = state.deliveries.get(id)
  if (entry === undefined) {
    return [Option.none(), state]
  }
  return [Option.some(entry), { ...state, deliveries: withoutEntry(state.deliveries, id) }]
}
