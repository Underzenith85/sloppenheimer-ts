/**
 * What happens between an agent turn ending and its work being on the remote.
 *
 * A successful turn is an agent-protocol fact and nothing more. Whether the workspace changed,
 * whether that change reached the remote, and whether the pull request may now be inspected are
 * three further facts, and Sloppenheimer used to collapse all four into one: a turn that reported
 * `completed` was treated as delivered work, and the only evidence consulted afterwards was the
 * remote head. A turn that edited files and could not push them therefore read as an agent that
 * had done nothing, and the recoverable diff was discarded with the verdict.
 *
 * So the postflight is stated here as its own step, in terms the host can verify: the worktree
 * against the baseline the preparation recorded, then a publication whose outcome is typed. The
 * agent's own account of what it did is never consulted.
 */

import { Effect, type Fiber } from 'effect'

import type { Issue } from '../domain/domain.js'
import type { SourceControlError } from '../domain/errors.js'
import type { PreparedRepository, SourceControlPort } from '../ports/index.js'
import { asSettled } from '../support/settled.js'
import type { ExecutionSnapshot } from './state.js'

/** A publication that did not happen, in the terms a retry and an operator both need. */
export type DeliveryFailure = Readonly<{
  category: SourceControlError['category']
  message: string
  /** Whether another publication attempt could succeed without the agent running again. */
  retryable: boolean
  /** Whether the local edits or commit remain available for that attempt. */
  worktreePreserved: boolean
}>

/**
 * The four outcomes a settled turn can leave behind, which the scheduler acts on instead of on the
 * turn's own status.
 *
 * `NotPerformed` is a host that owns no source control, where the agent publishes for itself and
 * the core continuation lifecycle runs unchanged.
 */
export type PostflightOutcome =
  | Readonly<{ _tag: 'NotPerformed' }>
  /** The host inspected the worktree and found nothing to deliver. */
  | Readonly<{ _tag: 'NoChanges'; branchName: string; baselineSha: string }>
  | Readonly<{
      _tag: 'Published'
      branchName: string
      baselineSha: string
      headSha: string
      commitCreated: boolean
    }>
  /** Work exists and is not on the remote. The workspace is retained for another attempt. */
  | Readonly<{
      _tag: 'DeliveryFailed'
      branchName: string
      /** How many paths the inspection found, or `null` when the inspection itself failed. */
      changedFileCount: number | null
      failure: DeliveryFailure
      /**
       * The preparation the retained work belongs to. A delivery retry republishes exactly this,
       * which is what lets it happen without the coding agent running again.
       */
      prepared: PreparedRepository
    }>

const failureOf = (error: SourceControlError): DeliveryFailure => ({
  category: error.category,
  message: error.message,
  retryable: error.retryable,
  worktreePreserved: error.worktreePreserved,
})

/**
 * Whether this outcome leaves work that another publication attempt could still deliver. A
 * failure that did not preserve the worktree has nothing left to retry: the agent has to run
 * again.
 */
export const deliveryIsRecoverable = (outcome: PostflightOutcome): boolean =>
  outcome._tag === 'DeliveryFailed' &&
  outcome.failure.retryable &&
  outcome.failure.worktreePreserved

/** The postflight outcome as one log token, so a line reads the same for every backend. */
export const postflightLogOutcome = (
  outcome: PostflightOutcome,
): 'not_performed' | 'no_changes' | 'published' | 'delivery_failed' => {
  switch (outcome._tag) {
    case 'NotPerformed': {
      return 'not_performed'
    }
    case 'NoChanges': {
      return 'no_changes'
    }
    case 'Published': {
      return 'published'
    }
    case 'DeliveryFailed': {
      return 'delivery_failed'
    }
  }
}

/** One line an operator can act on, for whichever outcome the postflight reached. */
export const postflightReason = (outcome: PostflightOutcome): string => {
  switch (outcome._tag) {
    case 'NotPerformed': {
      return 'The host does not own publication for this workflow'
    }
    case 'NoChanges': {
      return `The worktree matched its baseline ${outcome.baselineSha}; nothing was published`
    }
    case 'Published': {
      return `Published ${outcome.headSha} to ${outcome.branchName}`
    }
    case 'DeliveryFailed': {
      return `Delivery to ${outcome.branchName} failed (${outcome.failure.category}): ${outcome.failure.message}`
    }
  }
}

/**
 * The postflight itself: inspect, then publish what the inspection found.
 *
 * It cannot fail. Every way a publication can go wrong is an outcome the scheduler has a state
 * for, and raising one as a worker failure is what previously turned a delivery problem into an
 * agent retry.
 *
 * A clean worktree is not published. Nothing would be sent, and asking the remote to confirm that
 * costs a fetch and a lease read for an answer the inspection already gave.
 */
export const runPostflight = (
  sourceControl: SourceControlPort,
  issue: Issue,
  prepared: PreparedRepository,
): Effect.Effect<PostflightOutcome> =>
  Effect.gen(function* () {
    const branchName = prepared.target.branchName
    const inspected = yield* sourceControl.inspect(prepared).pipe(asSettled)
    if (inspected._tag === 'Failed') {
      return {
        _tag: 'DeliveryFailed',
        branchName,
        changedFileCount: null,
        failure: failureOf(inspected.error),
        prepared,
      }
    }
    if (inspected.value._tag === 'Clean') {
      return { _tag: 'NoChanges', branchName, baselineSha: prepared.baselineSha }
    }
    const changedFileCount = inspected.value.dirtyFileCount
    const published = yield* sourceControl.publish(issue, prepared).pipe(asSettled)
    if (published._tag === 'Failed') {
      return {
        _tag: 'DeliveryFailed',
        branchName,
        changedFileCount,
        failure: failureOf(published.error),
        prepared,
      }
    }
    // A publication that answers `NoChanges` after an inspection that found work is reporting the
    // adapter's own reading of the same worktree, so it is taken at its word rather than
    // reconciled: nothing reached the remote either way.
    return published.value._tag === 'NoChanges'
      ? { _tag: 'NoChanges', branchName, baselineSha: prepared.baselineSha }
      : {
          _tag: 'Published',
          branchName,
          baselineSha: prepared.baselineSha,
          headSha: published.value.headSha,
          commitCreated: published.value.commitCreated,
        }
  })

/**
 * One agent's work waiting to reach the remote, and the failure that left it here.
 *
 * The preparation is retained rather than rebuilt, because it is what makes the retry a
 * publication rather than a second agent run: the same worktree, the same baseline, and the same
 * expected remote head the turn was launched against.
 */
export type DeliveryEntry = Readonly<{
  issue: Issue
  execution: ExecutionSnapshot
  prepared: PreparedRepository
  /** How many publication attempts have failed for this retained work. */
  attempt: number
  /**
   * The worker attempt that produced the work. Carried so that giving up on the delivery continues
   * the agent's own attempt numbering rather than starting it over.
   */
  workerAttempt: number | null
  dueAt: number
  failure: DeliveryFailure
  /** Paths the inspection found, or `null` when the inspection itself is what failed. */
  changedFileCount: number | null
  /** Whether the run that produced this work was repairing a pull request. */
  repairRun: boolean
  observedAt: Date
  /**
   * The timer the next attempt is waiting on, or `null` while an operator pause has suspended it.
   * A pause stops agents; it does not throw away a change that already exists, so the entry
   * outlives the timer and a resume arms a new one.
   */
  fiber: Fiber.Fiber<void> | null
}>
