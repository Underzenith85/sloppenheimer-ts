import { Option } from 'effect'

import type { Issue } from '../domain/domain.js'
import { classifyPullRequest, type PullRequestObservation } from '../domain/handoff.js'
import type { HandoffEntry } from './state.js'

/** An observation of a pull request that is still open, and so has a head to reason about. */
type OpenPullRequest = Extract<PullRequestObservation, Readonly<{ state: 'open' }>>

/**
 * What one observation of a pull request leaves for the orchestrator to do. The decision itself is
 * pure — an observation in, the handoff it produces and the single call that must follow out — so
 * the repair budget, the review gate, and the cycle guard can all be exercised without a tracker.
 */
export type HandoffAction =
  | Readonly<{ _tag: 'None' }>
  /** Ask for a Codex review of this head. */
  | Readonly<{ _tag: 'RequestReview'; headSha: string }>
  /** Resolve stale review threads left behind by a verified repair. */
  | Readonly<{ _tag: 'ResolveThreads'; threadIds: readonly string[] }>
  | Readonly<{ _tag: 'Merge'; headSha: string }>
  /** Already merged when observed: the handoff is finished with. */
  | Readonly<{ _tag: 'Complete' }>
  /** Closed without merging: retained, but nothing further is attempted. */
  | Readonly<{ _tag: 'NoteClosed' }>
  | Readonly<{ _tag: 'Repair'; reason: string; headSha: string | null; attempt: number }>

export type HandoffDecision = Readonly<{
  handoff: HandoffEntry
  action: HandoffAction
}>

/** How many verified repairs a pull request gets before an operator has to look at it. */
export const repairLimit = 3

const decided = (
  handoff: HandoffEntry,
  action: HandoffAction = { _tag: 'None' },
): HandoffDecision => ({
  handoff,
  action,
})

/**
 * Whether a repaired head has come back clean enough that the review threads raised against the
 * head before it are stale rather than outstanding.
 */
const repairedHeadIsVerified = (
  handoff: HandoffEntry,
  observation: PullRequestObservation,
): boolean =>
  handoff.repairHeadShas.length > 0 &&
  observation.mergeable === true &&
  observation.mergeState !== 'dirty' &&
  observation.mergeState !== 'behind' &&
  observation.checks.every(
    (check) =>
      check.status === 'completed' &&
      check.conclusion !== null &&
      ['success', 'neutral', 'skipped'].includes(check.conclusion),
  )

/**
 * Attributes the head a finished repair agent produced, before anything else reads it.
 *
 * Returns the handoff to carry forward, or a decision when the observation is conclusive on its
 * own — a repair that cycled back to a head already seen, or one that changed nothing.
 */
const attributeRepair = (
  handoff: HandoffEntry,
  observation: OpenPullRequest,
): HandoffEntry | HandoffDecision => {
  const repairedHeadSha = observation.headSha
  if (repairedHeadSha !== handoff.repairStartedHeadSha) {
    if (handoff.repairObservedHeadShas.includes(repairedHeadSha)) {
      return decided({
        ...handoff,
        repairStartedHeadSha: null,
        repairBaselineRestored: false,
        state: 'intervention_required',
        headSha: repairedHeadSha,
        reason: 'Repair agent returned the pull request to an already observed repair head.',
      })
    }
    return {
      ...handoff,
      repairHeadShas: [...handoff.repairHeadShas, repairedHeadSha],
      repairObservedHeadShas: [...handoff.repairObservedHeadShas, repairedHeadSha],
      repairStartedHeadSha: null,
      repairBaselineRestored: false,
    }
  }
  if (handoff.repairBaselineRestored) {
    // The baseline outlived the process that dispatched the repair, so an unchanged head is an
    // interrupted repair, not a completed no-op. Drop the baseline and let the normal repair path
    // retry; no head was observed, so the budget is untouched.
    return { ...handoff, repairStartedHeadSha: null, repairBaselineRestored: false }
  }
  const unchanged = classifyPullRequest(observation)
  const cleared: HandoffEntry = { ...handoff, repairStartedHeadSha: null }
  if (unchanged.state === 'repair_needed') {
    return decided({
      ...cleared,
      state: 'intervention_required',
      headSha: repairedHeadSha,
      reason: `Repair agent completed without changing the pull request head. ${unchanged.reason}`,
    })
  }
  return cleared
}

/**
 * The review gate for an open pull request: every head is reviewed once, and nothing is merged
 * until the review for the head in hand has completed and settled.
 */
const gateReview = (
  handoff: HandoffEntry,
  observation: OpenPullRequest,
): Option.Option<HandoffDecision> => {
  const observedHeadSha = observation.headSha
  const codexReview = observation.codexReview
  if (handoff.reviewRequestedHeadSha !== observedHeadSha) {
    const reset: HandoffEntry = { ...handoff, reviewCompletedHeadSha: null }
    if (
      codexReview !== null &&
      codexReview !== undefined &&
      observedHeadSha.startsWith(codexReview.headShaPrefix)
    ) {
      // A review for this head already exists: adopt it rather than asking for a second one.
      return Option.some(
        decided(
          codexReview.status === 'completed'
            ? {
                ...reset,
                reviewRequestedHeadSha: observedHeadSha,
                reviewCompletedHeadSha: observedHeadSha,
                state: 'awaiting_checks',
                reason:
                  'Codex review completed for the current head; waiting for review state to settle',
              }
            : {
                ...reset,
                reviewRequestedHeadSha: observedHeadSha,
                state: 'awaiting_checks',
                reason: 'Waiting for Codex review of the current head to complete',
              },
        ),
      )
    }
    return Option.some(
      decided(
        { ...reset, state: 'awaiting_checks' },
        {
          _tag: 'RequestReview',
          headSha: observedHeadSha,
        },
      ),
    )
  }
  if (
    codexReview?.status !== 'completed' ||
    !observedHeadSha.startsWith(codexReview.headShaPrefix)
  ) {
    return Option.some(
      decided({
        ...handoff,
        reviewCompletedHeadSha: null,
        state: 'awaiting_checks',
        reason: 'Waiting for Codex review of the current head to complete',
      }),
    )
  }
  if (handoff.reviewCompletedHeadSha !== observedHeadSha) {
    return Option.some(
      decided({
        ...handoff,
        reviewCompletedHeadSha: observedHeadSha,
        state: 'awaiting_checks',
        reason: 'Codex review completed for the current head; waiting for review state to settle',
      }),
    )
  }
  // Nothing to say about the review: the disposition decides what happens to this head.
  return Option.none()
}

/**
 * The whole per-observation state machine, as one function. The order is the order the orchestrator
 * applied inline before this was extracted, and each step can end the pass.
 */
export const observeHandoff = (
  handoff: HandoffEntry,
  observation: PullRequestObservation,
  observedAt: Date,
): HandoffDecision => {
  const interventionRequired = handoff.state === 'intervention_required'
  const observed: HandoffEntry = { ...handoff, observedAt }
  // Intervention was requested, so no further repair is dispatched -- but the pull request is
  // still inspected every poll. An unchanged open head keeps the state and reason as they are;
  // a corrected head, a manual merge, or a close falls through and is acted on normally.
  if (
    interventionRequired &&
    observation.state === 'open' &&
    observation.headSha === handoff.headSha
  ) {
    return decided(observed)
  }
  let next = observed
  if (observation.state === 'open' && next.repairStartedHeadSha !== null) {
    const attributed = attributeRepair(next, observation)
    if ('action' in attributed) {
      return attributed
    }
    next = attributed
  }
  if (observation.state === 'open') {
    const gated = gateReview(next, observation)
    if (Option.isSome(gated)) {
      return gated.value
    }
  }
  const unresolvedThreadIds = observation.reviewThreads
    .filter((thread) => !thread.resolved && thread.commentHeadSha !== observation.headSha)
    .map((thread) => thread.id)
  if (unresolvedThreadIds.length > 0 && repairedHeadIsVerified(next, observation)) {
    return decided(
      { ...next, state: 'awaiting_checks' },
      {
        _tag: 'ResolveThreads',
        threadIds: unresolvedThreadIds,
      },
    )
  }
  const disposition = classifyPullRequest(observation)
  const settled: HandoffEntry = {
    ...next,
    state: disposition.state,
    headSha: observation.headSha,
    reason: 'reason' in disposition ? disposition.reason : null,
  }
  switch (disposition.state) {
    case 'merged': {
      return decided(settled, { _tag: 'Complete' })
    }
    case 'closed_without_merge': {
      return decided(settled, { _tag: 'NoteClosed' })
    }
    case 'ready_to_merge': {
      return decided(
        { ...settled, state: 'merging' },
        {
          _tag: 'Merge',
          headSha: disposition.headSha,
        },
      )
    }
    case 'repair_needed': {
      if (settled.repairHeadShas.length >= repairLimit) {
        return decided({
          ...settled,
          state: 'intervention_required',
          reason: `Repair limit reached. ${disposition.reason}`,
        })
      }
      return decided(settled, {
        _tag: 'Repair',
        reason: disposition.reason,
        headSha: observation.headSha,
        attempt: settled.repairHeadShas.length + 1,
      })
    }
    case 'awaiting_checks': {
      return decided(settled)
    }
  }
}

/** The pull request could not be inspected: the reason is recorded and nothing else changes. */
export const afterInspectionFailed = (
  handoff: HandoffEntry,
  observedAt: Date,
  message: string,
): HandoffEntry => ({ ...handoff, observedAt, reason: message })

export const afterReviewRequested = (
  handoff: HandoffEntry,
  headSha: string,
  failure: string | null,
): HandoffEntry =>
  failure === null
    ? {
        ...handoff,
        reviewRequestedHeadSha: headSha,
        reason: 'Codex review requested for the current head',
      }
    : { ...handoff, reason: `Could not request Codex review for the current head: ${failure}` }

export const afterThreadsResolved = (
  handoff: HandoffEntry,
  failure: string | null,
): HandoffEntry => ({
  ...handoff,
  reason: failure ?? 'Verified repair head; waiting for resolved review state',
})

export const afterMerge = (handoff: HandoffEntry, failure: string | null): HandoffEntry =>
  failure === null
    ? { ...handoff, state: 'merged' }
    : { ...handoff, state: 'awaiting_checks', reason: failure }

/** The issue a repair agent is dispatched against: the original, plus what it has to fix. */
export const repairIssue = (
  handoff: HandoffEntry,
  headSha: string | null,
  reason: string,
): Issue => ({
  ...handoff.issue,
  description: `${handoff.issue.description ?? ''}\n\n## Pull request repair\n\nPR: ${handoff.pullRequestUrl}\nHead: ${headSha}\n\n${reason}`,
})

export const awaitingSlot = (handoff: HandoffEntry, reason: string): HandoffEntry => ({
  ...handoff,
  reason: `Waiting for an agent slot. ${reason}`,
})

/**
 * The budget is spent by an observed head, not by dispatching: the baseline is recorded only once a
 * session really started, so a refused dispatch costs nothing.
 */
export const afterRepairDispatched = (
  handoff: HandoffEntry,
  started: boolean,
  headSha: string | null,
  reason: string,
): HandoffEntry =>
  started
    ? {
        ...handoff,
        repairStartedHeadSha: headSha,
        repairObservedHeadShas:
          headSha === null || handoff.repairObservedHeadShas.includes(headSha)
            ? handoff.repairObservedHeadShas
            : [...handoff.repairObservedHeadShas, headSha],
        repairBaselineRestored: false,
        reason: `Repair agent running. ${reason}`,
      }
    : handoff
