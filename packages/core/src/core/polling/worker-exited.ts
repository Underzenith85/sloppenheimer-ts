import { Clock, Effect, Option, Ref, type Scope } from 'effect'

import { currentInstant } from '../../support/clock.js'
import { logError, logInfo } from '../../support/logging.js'
import { asSettled } from '../../support/settled.js'
import { recordHandoff } from '../../telemetry.js'
import type { CodeReviewPort, HandoffResult } from '../../ports/index.js'
import { logContext, sessionLogContext } from '../policy.js'
import type { OrchestratorContext, OrchestratorEvent } from '../runtime.js'
import type { RunningEntry } from '../state.js'
import * as Transitions from '../transitions.js'

type WorkerExited = Extract<OrchestratorEvent, { _tag: 'WorkerExited' }>

type OpenedPullRequest = Extract<HandoffResult, { _tag: 'PullRequest' }>

/**
 * Files an opened pull request as this issue's handoff, and settles what the run that opened it
 * owes next: a repair that has just delivered its change gives the claim up, while normal completed
 * work continues the session.
 */
const adoptOpenedHandoff = (
  context: OrchestratorContext,
  event: WorkerExited,
  settled: RunningEntry,
  result: OpenedPullRequest,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const observedAt = yield* currentInstant
    yield* Ref.update(context.state, (current) =>
      Transitions.updateDetail(current, event.issueId, (record) => {
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
      const existing = current.handoffs.get(event.issueId)
      const next = Transitions.putHandoff(current, event.issueId, {
        issue: existing?.issue ?? settled.issue,
        execution: settled.execution,
        pullRequestNumber: result.pullRequestNumber,
        pullRequestUrl: result.pullRequestUrl,
        branchName: result.branchName,
        state: 'awaiting_checks',
        headSha: existing?.headSha ?? null,
        reason: 'Awaiting the first protected-branch observation',
        repairHeadShas: existing?.repairHeadShas ?? [],
        repairObservedHeadShas: existing?.repairObservedHeadShas ?? [],
        repair: existing === undefined ? Option.none() : existing.repair,
        reviewRequestedHeadSha: existing?.reviewRequestedHeadSha ?? null,
        reviewCompletedHeadSha: existing?.reviewCompletedHeadSha ?? null,
        observedAt: handedOffAt,
      })
      return [settled.repairRun, next] as const
    })
    yield* context.persistHandoffs
    yield* logInfo('worker handed off pull request', {
      ...logContext(settled.issue),
      action: 'pull_request_handoff',
      outcome: 'completed',
      error: null,
      branch: result.branchName,
      pull_request_url: result.pullRequestUrl,
    })
    if (completedRepair) {
      yield* Ref.update(context.state, (current) =>
        Transitions.releaseClaim(current, event.issueId),
      )
    } else {
      yield* context.scheduleRetry(settled.issue, 1, null, true, false)
    }
  })

/**
 * Asks the code-review port to hand the completed work over, recording each step of the attempt in
 * the detail as it happens. A failed request or a branch that was never pushed schedules the
 * continuation the run would otherwise have had.
 */
const requestHandoff = (
  context: OrchestratorContext,
  event: WorkerExited,
  settled: RunningEntry,
  codeReview: CodeReviewPort,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Published before the tracker call, not after it: the worker is already out of the
    // running map, so an open detail panel would otherwise keep reading the previous
    // snapshot as running — and count it down to stalled — for as long as the handoff
    // request takes.
    const handingOffAt = yield* currentInstant
    yield* Ref.update(context.state, (current) =>
      Transitions.updateDetail(current, event.issueId, (record) =>
        recordHandoff(record, handingOffAt, {
          step: 'remote_branch',
          status: 'pending',
          message: 'Looking for a pushed branch to hand off',
        }),
      ),
    )
    yield* context.publish
    const handoff = yield* codeReview.handoffCompletedWork(settled.issue).pipe(asSettled)
    if (handoff._tag === 'Failed') {
      const failedAt = yield* currentInstant
      yield* Ref.update(context.state, (current) =>
        Transitions.updateDetail(current, event.issueId, (record) =>
          recordHandoff(record, failedAt, {
            step: 'remote_branch',
            status: 'failed',
            message: handoff.error.message,
            outcome: 'failed',
          }),
        ),
      )
      yield* context.scheduleRetry(
        settled.issue,
        (event.attempt ?? 0) + 1,
        `handoff failed: ${handoff.error.message}`,
        false,
        settled.repairRun,
      )
      return
    }
    const result = handoff.value
    if (result._tag === 'NoBranch') {
      const absentAt = yield* currentInstant
      yield* Ref.update(context.state, (current) =>
        Transitions.updateDetail(current, event.issueId, (record) =>
          recordHandoff(record, absentAt, {
            step: 'remote_branch',
            status: 'absent',
            message: `No remote branch ${result.branchName} exists yet; continuing the session`,
            remoteBranch: result.branchName,
            outcome: 'no_branch',
          }),
        ),
      )
      yield* context.scheduleRetry(settled.issue, 1, null, true, settled.repairRun)
      return
    }
    yield* adoptOpenedHandoff(context, event, settled, result)
  })

/**
 * A worker fiber ending. The run leaves the running map first, so its buffered telemetry settles
 * and its detail stops counting itself down to stalled before anything slow happens.
 */
export const onWorkerExited = (
  context: OrchestratorContext,
  event: WorkerExited,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ended = yield* Ref.modify(context.state, (current) =>
      Transitions.endRun(current, event.issueId, event.runId),
    )
    if (Option.isNone(ended)) {
      return
    }
    const settled = yield* Ref.modify(context.state, (current) =>
      Transitions.applyPendingTelemetry(current, event.issueId, ended.value),
    )
    const endedAt = yield* Clock.currentTimeMillis
    yield* Ref.update(context.state, (current) =>
      Transitions.accountEndedRun(current, settled, endedAt),
    )
    if (settled.sessionId !== null) {
      yield* (event.outcome === 'normal' ? logInfo : logError)(
        event.outcome === 'normal'
          ? 'action=session outcome=completed'
          : 'action=session outcome=failed',
        {
          ...sessionLogContext(settled),
          action: 'session',
          outcome: event.outcome === 'normal' ? 'completed' : 'failed',
          error: event.error,
        },
      )
    }
    if (event.outcome !== 'normal') {
      yield* context.scheduleRetry(
        settled.issue,
        (event.attempt ?? 0) + 1,
        event.error,
        false,
        settled.repairRun,
      )
      return
    }
    const codeReview = settled.execution.codeReview
    if (Option.isNone(codeReview)) {
      yield* context.scheduleRetry(settled.issue, 1, null, true, settled.repairRun)
      return
    }
    yield* requestHandoff(context, event, settled, codeReview.value)
  })
