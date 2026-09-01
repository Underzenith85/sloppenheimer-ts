import { Option } from 'effect'

import {
  classifyPullRequest,
  outdatedThreadNote,
  outdatedReviewThreads,
  type HandoffDisposition,
  type PullRequestObservation,
} from '../domain/handoff.js'
import { releaseRepair } from './repair.js'
import type { HandoffEntry, RepairEntry } from './state.js'

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
  /**
   * Retire the review threads a verified head superseded. The head is carried so the write can be
   * leased on it: the verdict is about this commit, and a pull request that has moved past it must
   * refuse rather than resolve.
   */
  | Readonly<{ _tag: 'ResolveThreads'; headSha: string; threadIds: readonly string[] }>
  | Readonly<{ _tag: 'Merge'; headSha: string }>
  /**
   * Already merged when observed: the handoff is finished with. The instant is the provider's own
   * when it reports one, because a handoff read back from the store after a restart is observed
   * now but may have merged long before.
   */
  | Readonly<{ _tag: 'Complete'; mergedAt: string | null }>
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
 * The merge states in which GitHub has finished deciding. `clean` is merge-ready, and `blocked` is
 * a decided answer too: something the repository requires -- a review, or resolved conversations
 * -- is outstanding, which is exactly the case retiring a thread has to be able to clear. Every
 * other state is GitHub still working the answer out or reporting a signal against this head, and
 * resolving on the strength of one would retire feedback ahead of the verdict.
 */
const settledMergeStates = new Set(['clean', 'blocked'])

/**
 * Whether the head in hand has come back clean enough to retire the feedback the provider has
 * already marked outdated against it. The review gate has passed by the time this is asked, so
 * this states the rest of the condition: GitHub has settled, there is no conflict, and every check
 * is green.
 *
 * It does not ask whether Sloppenheimer performed the repair. A pull request restored from the
 * store, or one a human pushed the fix for, carries retired threads that nobody else will clear,
 * and a protection rule requiring resolved conversations would otherwise hold it forever.
 */
const headIsVerified = (observation: PullRequestObservation): boolean =>
  observation.mergeable === true &&
  observation.mergeState !== null &&
  settledMergeStates.has(observation.mergeState) &&
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
/**
 * What a head a repair produced does to that repair's accounting.
 *
 * `Cycled` is a repair that returned the pull request to a head already seen, which no further
 * repair can improve on; `Attributed` spends one of the budget and adds the head to the set cycle
 * detection reads. Both end the repair, so both release its identity.
 */
export type RepairAttribution =
  | Readonly<{ _tag: 'Attributed'; handoff: HandoffEntry }>
  | Readonly<{ _tag: 'Cycled'; handoff: HandoffEntry }>

/**
 * Records a head as a repair's output. Stated once because two paths attribute heads -- the
 * reconciliation pass, and a queued repair retry settling the attempt that queued it -- and they
 * have to spend the budget and populate the cycle set identically or the accounting drifts.
 *
 * The caller decides whether the head is this repair's output at all; this decides what that
 * costs.
 */
export const attributeRepairHead = (
  handoff: HandoffEntry,
  observedHeadSha: string,
): RepairAttribution =>
  handoff.repairObservedHeadShas.includes(observedHeadSha)
    ? {
        _tag: 'Cycled',
        handoff: {
          ...releaseRepair(handoff),
          state: 'intervention_required',
          headSha: observedHeadSha,
          reason: 'Repair agent returned the pull request to an already observed repair head.',
        },
      }
    : {
        _tag: 'Attributed',
        handoff: {
          ...releaseRepair(handoff),
          repairHeadShas: [...handoff.repairHeadShas, observedHeadSha],
          repairObservedHeadShas: [...handoff.repairObservedHeadShas, observedHeadSha],
        },
      }

const attributeRepair = (
  handoff: HandoffEntry,
  observation: OpenPullRequest,
  repair: RepairEntry,
): HandoffEntry | HandoffDecision => {
  const repairedHeadSha = observation.headSha
  const released = releaseRepair(handoff)
  if (!repair.inFlight && !repair.workerStarted) {
    // A dispatch refused before any worker started, whose queued retry did not outlive the process
    // that held it. Nothing ran, so whatever the head is now belongs to nobody: drop the identity
    // and let this same pass decide the repair again from scratch.
    return released
  }
  if (repairedHeadSha !== repair.startedHeadSha) {
    const attribution = attributeRepairHead(handoff, repairedHeadSha)
    return attribution._tag === 'Cycled' ? decided(attribution.handoff) : attribution.handoff
  }
  if (repair.publication === 'published' && repair.publishedHeadSha !== repairedHeadSha) {
    // The host pushed a head the provider is still not reporting. Waiting for the observation to
    // catch up costs a poll; releasing the repair here — which a restored one, whose `inFlight` is
    // always false, would otherwise do — lets the stale head buy another repair.
    return decided({
      ...handoff,
      state: 'awaiting_checks',
      headSha: repairedHeadSha,
      reason: 'Published the repair; waiting for the pull request to report the new head.',
    })
  }
  if (!repair.inFlight) {
    // The baseline outlived whatever was driving the repair, so an unchanged head is an interrupted
    // repair, not a completed no-op. Drop the baseline and let the normal repair path retry; no
    // head was observed, so the budget is untouched.
    return released
  }
  if (repair.publication === 'delivery_failed') {
    // The turn produced work the host could not publish. An unchanged head says nothing about what
    // the agent achieved here, so no verdict is reached on it: the retained delivery owns the work,
    // and the repair keeps its identity until that delivery settles it one way or the other.
    return decided({
      ...handoff,
      state: 'delivery_failed',
      headSha: repairedHeadSha,
      reason:
        'Repair agent produced changes that have not reached the pull request; delivery is being retried.',
    })
  }
  const unchanged = classifyPullRequest(observation)
  if (unchanged.state === 'repair_needed') {
    return decided({
      ...released,
      state: 'intervention_required',
      headSha: repairedHeadSha,
      reason: `Repair agent completed without changing the pull request head. ${unchanged.reason}`,
    })
  }
  return released
}

/**
 * The review gate for an open pull request: every head is reviewed once, and nothing is merged
 * until the review for the head in hand has completed and settled.
 *
 * Exported because a repair is gated on it too. A head that has not been reviewed yet has no
 * review feedback to repair against, so repairing it would spend one of the budget on a guess.
 * `None` means the head is settled and the disposition decides what happens to it.
 */
export const gateReview = (
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
 * What the operator is told about this observation: the disposition's own reason, plus a line for
 * the outdated feedback that was deliberately kept out of it. Diagnostics retain what a repair
 * request must not restate.
 */
const recordedReason = (
  disposition: HandoffDisposition,
  observation: PullRequestObservation,
): string | null => {
  const reason = 'reason' in disposition ? disposition.reason : null
  const history = outdatedThreadNote(observation)
  if (history === null) {
    return reason
  }
  return reason === null ? history : `${reason}\n\n${history}`
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
  const inFlightRepair = next.repair
  if (observation.state === 'open' && Option.isSome(inFlightRepair)) {
    const attributed = attributeRepair(next, observation, inFlightRepair.value)
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
  // Only feedback the provider has retired is resolved, and only once the head that retired it
  // has come back clean. A thread still raised against this head is outstanding work whoever
  // wrote it, and withholding one from a repair request says nothing about it on GitHub.
  const retiredThreadIds = outdatedReviewThreads(observation).map((thread) => thread.id)
  if (observation.state === 'open' && retiredThreadIds.length > 0 && headIsVerified(observation)) {
    return decided(
      { ...next, state: 'awaiting_checks' },
      {
        _tag: 'ResolveThreads',
        headSha: observation.headSha,
        threadIds: retiredThreadIds,
      },
    )
  }
  const disposition = classifyPullRequest(observation)
  const settled: HandoffEntry = {
    ...next,
    state: disposition.state,
    headSha: observation.headSha,
    // The operator's record keeps the withheld history; the repair request below carries the
    // disposition's reason alone, so an agent is never handed feedback it cannot act on.
    reason: recordedReason(disposition, observation),
  }
  switch (disposition.state) {
    case 'merged': {
      return decided(settled, { _tag: 'Complete', mergedAt: observation.mergedAt ?? null })
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
          reason: `Repair limit reached. ${settled.reason ?? disposition.reason}`,
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
