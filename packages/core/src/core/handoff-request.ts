/**
 * Handing settled work over to the code-review capability.
 *
 * Two things reach this point: a worker whose turn and postflight have both settled, and a
 * retained delivery whose publication finally succeeded. They are the same event as far as the
 * pull request is concerned — work is on the remote and something has to look at it — so the
 * handoff is stated once here, against a settled-work record rather than against a live run.
 */

import { Effect, Option, Ref } from 'effect'

import type { Issue } from '../domain/domain.js'
import { currentInstant } from '../support/clock.js'
import { logInfo, withLogAnnotations } from '../support/logging.js'
import { handoffOutcomes, recordOutcome, withOperationalSpan } from '../support/observability.js'
import { asSettled } from '../support/settled.js'
import { recordHandoff } from '../telemetry.js'
import type { CodeReviewPort, HandoffResult } from '../ports/index.js'
import { logContext } from './policy.js'
import { reactivateRepair } from './repair.js'
import type { OrchestratorContext } from './runtime.js'
import type { ExecutionSnapshot } from './state.js'
import * as Transitions from './transitions.js'

type OpenedPullRequest = Extract<HandoffResult, { _tag: 'PullRequest' }>

/**
 * One piece of work that has settled, in the terms the handoff needs it.
 *
 * Deliberately not a `RunningEntry`: a delivery that succeeded on its third attempt has no live
 * run behind it, and the handoff it is owed is the same one the original turn was owed.
 */
export type SettledWork = Readonly<{
  issue: Issue
  execution: ExecutionSnapshot
  /** The worker attempt this work came from, which a fallback retry continues from. */
  attempt: number | null
  /** Whether the run that produced this work was repairing a pull request. */
  repairRun: boolean
}>

/**
 * Puts a repair back behind the retry that is now queued for it.
 *
 * Only reached when nothing more can be published from the workspace and the agent has to run
 * again. A repair rediscovered from a workspace after a restart is restored with no attempt behind
 * it, and the retry that comes due consults exactly that to decide whether to dispatch a repair or
 * a bare continuation — so without this the queued repair retry would arrive as an ordinary turn,
 * without the pull request's prompt or its expected head, and leave the old identity attached.
 */
export const putRepairBehindRetry = (
  context: OrchestratorContext,
  work: SettledWork,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const handoff = (yield* Ref.get(context.state)).handoffs.get(work.issue.id)
    if (handoff === undefined) {
      return
    }
    const reactivated = reactivateRepair(handoff)
    if (reactivated === handoff) {
      return
    }
    yield* Ref.update(context.state, (current) =>
      Transitions.putHandoff(current, work.issue.id, reactivated),
    )
    yield* context.persistHandoffs
  })

/**
 * Files an opened pull request as this issue's handoff, and settles what the run that opened it
 * owes next: a repair that has just delivered its change gives the claim up, while normal completed
 * work continues the session.
 */
const adoptOpenedHandoff = (
  context: OrchestratorContext,
  work: SettledWork,
  result: OpenedPullRequest,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const observedAt = yield* currentInstant
    yield* Ref.update(context.state, (current) =>
      Transitions.updateDetail(current, work.issue.id, (record) => {
        const branchObserved = recordHandoff(record, observedAt, {
          step: 'remote_branch',
          status: 'observed',
          message: `Remote branch ${result.branchName} is present`,
          remoteBranch: result.branchName,
        })
        const opened = recordHandoff(branchObserved, observedAt, {
          step: 'pull_request',
          status: 'observed',
          message: result.created
            ? 'Opened a pull request for the completed work'
            : 'Reused the pull request already open for this branch',
          pullRequest: {
            status: result.created ? 'created' : 'reused',
            number: result.pullRequestNumber,
            url: result.pullRequestUrl,
            state: 'awaiting_checks',
          },
          outcome: 'pull_request_open',
        })
        return recordHandoff(opened, observedAt, {
          step: 'dispatch_label',
          status: opened.handoff.dispatchLabels.status,
          message: opened.handoff.dispatchLabels.reason,
        })
      }),
    )
    const handedOffAt = yield* currentInstant
    const completedRepair = yield* Ref.modify(context.state, (current) => {
      // Carried over, not reset: the worker attempt number is not a repair count, and an
      // existing handoff already holds the heads that were actually observed.
      const existing = current.handoffs.get(work.issue.id)
      const next = Transitions.putHandoff(current, work.issue.id, {
        issue: existing?.issue ?? work.issue,
        execution: work.execution,
        pullRequestNumber: result.pullRequestNumber,
        pullRequestUrl: result.pullRequestUrl,
        branchName: result.branchName,
        state: 'awaiting_checks',
        headSha: existing?.headSha ?? null,
        reason: 'Awaiting the first protected-branch observation',
        repairHeadShas: existing?.repairHeadShas ?? [],
        repairObservedHeadShas: existing?.repairObservedHeadShas ?? [],
        repair: existing === undefined ? Option.none() : existing.repair,
        rebase: existing === undefined ? Option.none() : existing.rebase,
        reviewRequestedHeadSha: existing?.reviewRequestedHeadSha ?? null,
        reviewCompletedHeadSha: existing?.reviewCompletedHeadSha ?? null,
        observedAt: handedOffAt,
      })
      return [work.repairRun, next] as const
    })
    yield* context.persistHandoffs
    yield* logInfo('worker handed off pull request', {
      ...logContext(work.issue),
      action: 'pull_request_handoff',
      outcome: 'completed',
      error: null,
      branch: result.branchName,
      pull_request_url: result.pullRequestUrl,
    })
    yield* recordOutcome(handoffOutcomes, 'completed')
    if (completedRepair) {
      yield* Ref.update(context.state, (current) =>
        Transitions.releaseClaim(current, work.issue.id),
      )
    } else {
      yield* context.scheduleRetry(work.issue, 1, null, true, false)
    }
  })

/**
 * Asks the code-review port to hand the completed work over, recording each step of the attempt in
 * the detail as it happens. A failed request or a branch that was never pushed schedules the
 * continuation the run would otherwise have had.
 */
const runHandoff = (
  context: OrchestratorContext,
  work: SettledWork,
  codeReview: CodeReviewPort,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Published before the tracker call, not after it: the worker is already out of the
    // running map, so an open detail panel would otherwise keep reading the previous
    // snapshot as running — and count it down to stalled — for as long as the handoff
    // request takes.
    const handingOffAt = yield* currentInstant
    yield* Ref.update(context.state, (current) =>
      Transitions.updateDetail(current, work.issue.id, (record) =>
        recordHandoff(record, handingOffAt, {
          step: 'remote_branch',
          status: 'pending',
          message: 'Looking for a pushed branch to hand off',
        }),
      ),
    )
    yield* context.publish
    const handoff = yield* codeReview.handoffCompletedWork(work.issue).pipe(asSettled)
    if (handoff._tag === 'Failed') {
      yield* recordOutcome(handoffOutcomes, 'failed')
      const failedAt = yield* currentInstant
      yield* Ref.update(context.state, (current) =>
        Transitions.updateDetail(current, work.issue.id, (record) =>
          recordHandoff(record, failedAt, {
            step: 'remote_branch',
            status: 'failed',
            message: handoff.error.message,
            outcome: 'failed',
          }),
        ),
      )
      const retried = yield* context.scheduleRetry(
        work.issue,
        (work.attempt ?? 0) + 1,
        `handoff failed: ${handoff.error.message}`,
        false,
        work.repairRun,
      )
      if (retried && work.repairRun) {
        yield* putRepairBehindRetry(context, work)
      }
      return
    }
    const result = handoff.value
    if (result._tag === 'NoBranch') {
      yield* recordOutcome(handoffOutcomes, 'no_branch')
      const absentAt = yield* currentInstant
      yield* Ref.update(context.state, (current) =>
        Transitions.updateDetail(current, work.issue.id, (record) =>
          recordHandoff(record, absentAt, {
            step: 'remote_branch',
            status: 'absent',
            message: `No remote branch ${result.branchName} exists yet; continuing the session`,
            remoteBranch: result.branchName,
            outcome: 'no_branch',
          }),
        ),
      )
      const continued = yield* context.scheduleRetry(work.issue, 1, null, true, work.repairRun)
      if (continued && work.repairRun) {
        yield* putRepairBehindRetry(context, work)
      }
      return
    }
    yield* adoptOpenedHandoff(context, work, result)
  })

/** A handoff can follow a worker or a retained delivery; both share one trace/log boundary. */
export const requestHandoff = (
  context: OrchestratorContext,
  work: SettledWork,
  codeReview: CodeReviewPort,
): Effect.Effect<void> =>
  runHandoff(context, work, codeReview).pipe(
    withOperationalSpan('handoff', {
      issue_id: work.issue.id,
      attempt: work.attempt,
      repair: work.repairRun,
    }),
    withLogAnnotations({
      issue_id: work.issue.id,
      issue_identifier: work.issue.identifier,
      attempt: work.attempt,
      handoff: true,
    }),
  )
