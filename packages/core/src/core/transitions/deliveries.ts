import { type Fiber, Option } from 'effect'

import type { IssueId } from '../../domain/domain.js'
import { withEntry, withoutEntry } from '../../support/collections.js'
import type { DeliveryEntry } from '../postflight.js'
import type { RuntimeState } from '../state.js'
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
 * Takes the delivery an attempt has just reported on, and only that one.
 *
 * A settlement is this delivery's only while the entry is the one that attempt was publishing:
 * anything that superseded it, held it, or dropped it in the meantime has already decided what
 * becomes of the work, and a late report finds nothing to settle.
 */
export const takeAttemptedDelivery = (
  state: RuntimeState,
  id: IssueId,
  attempt: number,
): readonly [Option.Option<DeliveryEntry>, RuntimeState] => {
  const entry = state.deliveries.get(id)
  if (entry?.attempt !== attempt || entry.publishingSince === null) {
    return [Option.none(), state]
  }
  return [Option.some(entry), { ...state, deliveries: withoutEntry(state.deliveries, id) }]
}

/**
 * Hands over the delivery whose timer has come due, and records the fiber now publishing it.
 *
 * Deliberately not a removal. The publication runs off the event loop, so a poll can interleave
 * with it, and an entry taken out of the state for the duration would be an issue with a claim
 * nobody holds, no `delivering` row, and a workspace the recovery sweep counts as nobody's — with
 * an agent free to be sent into the very worktree the push is reading. The entry stays where it is
 * until the attempt reports back; what changes is what its fiber is, from a timer waiting to
 * publish to the publication itself.
 */
export const beginDeliveryAttempt = (
  state: RuntimeState,
  id: IssueId,
  attempt: number,
  fiber: Fiber.Fiber<void>,
  at: Date,
): readonly [Option.Option<DeliveryEntry>, RuntimeState] => {
  const entry = state.deliveries.get(id)
  if (entry?.attempt !== attempt || entry.publishingSince !== null) {
    return [Option.none(), state]
  }
  return [
    Option.some(entry),
    {
      ...state,
      deliveries: withEntry(state.deliveries, id, { ...entry, fiber, publishingSince: at }),
    },
  ]
}

/**
 * Puts a delivery back with no timer behind it. The work is retained and nothing is waiting to
 * publish it, which is where a delivery that came due for a paused issue belongs until the
 * operator lifts the pause.
 */
export const holdDelivery = (state: RuntimeState, entry: DeliveryEntry): RuntimeState => {
  const claimed = claimIssue(state, entry.issue)
  return {
    ...claimed,
    deliveries: withEntry(claimed.deliveries, entry.issue.id, {
      ...entry,
      fiber: null,
      publishingSince: null,
    }),
  }
}

/**
 * Retains a delivery with no timer behind it, returning the entry whose timer the caller must
 * interrupt. This is what an operator pause does to work that is already in a workspace: the
 * change is kept, and only the attempt waiting to publish it is called off.
 */
export const suspendDelivery = (
  state: RuntimeState,
  id: IssueId,
): readonly [Option.Option<DeliveryEntry>, RuntimeState] => {
  const entry = state.deliveries.get(id)
  // A publication already under way is deliberately left to finish. Interrupting a push mid-flight
  // is what leaves the remote in a state nobody can name, and the pause is not lost: the attempt
  // settles, and whatever it schedules next reads the pause before it publishes anything.
  if (entry === undefined || entry.fiber === null || entry.publishingSince !== null) {
    return [Option.none(), state]
  }
  return [
    Option.some(entry),
    { ...state, deliveries: withEntry(state.deliveries, id, { ...entry, fiber: null }) },
  ]
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
