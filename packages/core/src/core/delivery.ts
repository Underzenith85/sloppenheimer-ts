/**
 * What the scheduler does with a settled postflight.
 *
 * The turn is over by the time anything here runs, so nothing in this module can fail the run: it
 * decides which of four states the work is in and who owes it what next. Both callers reach the
 * same decision — the worker whose turn just ended, and a retained delivery whose retry has just
 * republished the same worktree — because a publication that succeeds on the third attempt owes
 * the pull request exactly what the first one would have.
 */

import { Effect, Option, Ref, type Scope } from 'effect'

import { currentInstant } from '../support/clock.js'
import { recordPublication } from '../telemetry.js'
import { notePublication } from './handoff-decision.js'
import { requestHandoff, type SettledWork } from './handoff-request.js'
import { postflightReason, type PostflightOutcome } from './postflight.js'
import type { OrchestratorContext } from './runtime.js'
import type { RepairPublication } from './state.js'
import * as Transitions from './transitions.js'

/** How a postflight outcome reads as the verdict a repair carries. */
const repairPublicationOf = (outcome: PostflightOutcome): RepairPublication => {
  switch (outcome._tag) {
    case 'NotPerformed': {
      return 'pending'
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

/**
 * Writes the postflight into the issue's telemetry, and into the repair identity when one is in
 * flight.
 *
 * The repair write is what keeps "the agent changed nothing" from being inferred from an unchanged
 * pull-request head: the head alone cannot tell a clean worktree from a push that failed, and this
 * is the record that can.
 */
const recordOutcome = (
  context: OrchestratorContext,
  work: SettledWork,
  outcome: PostflightOutcome,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (outcome._tag === 'NotPerformed') {
      return
    }
    const observedAt = yield* currentInstant
    if (outcome._tag !== 'DeliveryFailed') {
      yield* Ref.update(context.state, (current) =>
        Transitions.updateDetail(current, work.issue.id, (record) =>
          recordPublication(record, observedAt, {
            status: outcome._tag === 'Published' ? 'published' : 'no_changes',
            branch: outcome.branchName,
            baselineSha: outcome.baselineSha,
            headSha: outcome._tag === 'Published' ? outcome.headSha : null,
            message: postflightReason(outcome),
          }),
        ),
      )
    }
    const handoff = (yield* Ref.get(context.state)).handoffs.get(work.issue.id)
    if (handoff === undefined) {
      return
    }
    const noted = notePublication(handoff, repairPublicationOf(outcome))
    // A pull request whose latest work never reached it is in a state of its own. Saying so on the
    // handoff is what keeps the console from reporting the unchanged head as a repair that
    // achieved nothing, and what an operator reads while the delivery retries.
    const next =
      outcome._tag === 'DeliveryFailed'
        ? {
            ...noted,
            state: 'delivery_failed' as const,
            reason: `The agent's changes have not reached the pull request: ${outcome.failure.message}`,
          }
        : noted
    if (next === handoff) {
      return
    }
    yield* Ref.update(context.state, (current) =>
      Transitions.putHandoff(current, work.issue.id, next),
    )
    yield* context.persistHandoffs
  })

/**
 * The postflight state machine's one effectful step: given what the host made of the workspace,
 * decide what the issue is owed.
 *
 * `deliveryAttempt` is which publication attempt this outcome settles — 1 for a turn's own
 * postflight, and one higher for each retry after it. It governs the delivery backoff alone; the
 * agent's attempt number is `work.attempt` and does not move, because no agent ran.
 */
export const settlePostflight = (
  context: OrchestratorContext,
  work: SettledWork,
  outcome: PostflightOutcome,
  deliveryAttempt: number,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* recordOutcome(context, work, outcome)
    if (outcome._tag === 'DeliveryFailed') {
      const queued = yield* context.scheduleDelivery({
        issue: work.issue,
        execution: work.execution,
        prepared: outcome.prepared,
        attempt: deliveryAttempt,
        workerAttempt: work.attempt,
        failure: outcome.failure,
        changedFileCount: outcome.changedFileCount,
        repairRun: work.repairRun,
      })
      if (queued) {
        return
      }
      // Nothing more can be published from this workspace, so the work goes back to the agent —
      // which is a different thing from the run having failed, and is recorded as such.
      const abandonedAt = yield* currentInstant
      yield* Ref.update(context.state, (current) =>
        Transitions.updateDetail(current, work.issue.id, (record) =>
          recordPublication(record, abandonedAt, {
            status: 'failed',
            branch: outcome.branchName,
            baselineSha: outcome.prepared.baselineSha,
            category: outcome.failure.category,
            attempts: deliveryAttempt,
            message: `${outcome.failure.message}. The work cannot be delivered as it stands; the agent runs again.`,
          }),
        ),
      )
      yield* context.scheduleRetry(
        work.issue,
        (work.attempt ?? 0) + 1,
        `delivery failed: ${outcome.failure.message}`,
        false,
        work.repairRun,
      )
      return
    }
    const codeReview = work.execution.codeReview
    if (Option.isNone(codeReview)) {
      yield* context.scheduleRetry(work.issue, 1, null, true, work.repairRun)
      return
    }
    yield* requestHandoff(context, work, codeReview.value)
  })
