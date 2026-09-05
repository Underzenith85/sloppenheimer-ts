import { Effect, Option, Ref } from 'effect'

import type { Issue, IssueId } from '../../domain/domain.js'
import { currentInstant } from '../../support/clock.js'
import {
  logContext,
  hasSlot,
  issueIsActive,
  issueIsPaused,
  issueIsRoutable,
  stateIsIn,
} from '../policy.js'
import { logInfo, logWarning } from '../../support/logging.js'
import { recordOutcome, retryOutcomes } from '../../support/observability.js'
import { asSettled } from '../../support/settled.js'
import { dispatch } from '../dispatch.js'
import { rebaseInFlight } from '../rebase.js'
import { settleRepair } from '../repair.js'
import { repairPermission } from '../handoff-eligibility.js'
import { applyHandoffObservation, reconcileHandoffs } from '../handoff-reconciliation.js'
import { stopRetentionPass } from '../run-workspace.js'
import type { OrchestratorContext, OrchestratorEvent } from '../runtime.js'
import type { EffectiveWorkflow, HandoffEntry } from '../state.js'
import * as Transitions from '../transitions.js'
import { endRetryForPause } from './paused-retry.js'
import { releaseHandoffRepair, writeHandoff } from './repair-identity.js'

type RetryDue = Extract<OrchestratorEvent, { _tag: 'RetryDue' }>

/**
 * Observes the pull request of a handoff that is not repairing, before this retry can put another
 * worker on the issue. Answers whether the handoff took the issue over, in which case the retry
 * this pass took is spent.
 */
const handoffTookOver = (context: OrchestratorContext, issueId: IssueId): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const awaiting = yield* Ref.get(context.state)
    const awaitingHandoff = Option.fromNullable(awaiting.handoffs.get(issueId))
    if (!Option.exists(awaitingHandoff, (entry) => Option.isNone(entry.repair))) {
      return false
    }
    // Taking the due retry creates the boundary at which the handoff no longer has a
    // queued or running continuation. Observe that pull request before another worker can
    // take ownership, so checks, review, merge, or repair cannot be starved by an active
    // issue that keeps completing normal continuation turns.
    yield* reconcileHandoffs(context, true, Option.some(issueId))
    const reconciled = yield* Ref.get(context.state)
    const handoff = reconciled.handoffs.get(issueId)
    return (
      handoff === undefined ||
      reconciled.running.has(issueId) ||
      reconciled.retries.has(issueId) ||
      // A rebase the pass just started is moving the branch this continuation would start from.
      // The handoff has the issue for now; the poll re-dispatches it once the claim is released.
      rebaseInFlight(handoff)
    )
  })

/**
 * The retry an in-flight repair was waiting on: the repair's own baseline is re-inspected against
 * the pull request it is repairing, and the handoff state machine decides what happens next.
 */
const resumeRepair = (
  context: OrchestratorContext,
  event: RetryDue,
  entry: HandoffEntry,
  issue: Option.Option<Issue>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const repair = entry.repair
    if (Option.isNone(repair)) {
      return
    }
    const codeReview = entry.execution.codeReview
    if (Option.isNone(codeReview)) {
      yield* releaseHandoffRepair(context, event.issueId, Option.some(entry))
      return
    }
    const terminalIssue = Option.filter(issue, (record) =>
      stateIsIn(record.state, entry.execution.workflow.config.tracker.terminalStates),
    )
    if (Option.isSome(terminalIssue) && context.durable === undefined) {
      yield* stopRetentionPass(context, event.issueId)
      yield* entry.execution.workspaces.remove(terminalIssue.value.identifier).pipe(
        Effect.zipRight(
          Ref.update(context.state, (pending) =>
            Transitions.forgetRetainedWorkspaces(pending, event.issueId),
          ),
        ),
        Effect.catchAll((error) =>
          logWarning('terminal workspace cleanup failed', {
            ...logContext(terminalIssue.value),
            action: 'workspace_cleanup',
            outcome: 'failed',
            error: error.message,
          }),
        ),
      )
    }
    const inspected = yield* codeReview.value
      .inspectPullRequest(entry.pullRequestNumber)
      .pipe(asSettled)
    if (inspected._tag === 'Failed') {
      const scheduled = yield* context.scheduleRetry(
        repair.value.issue,
        event.attempt + 1,
        `repair baseline refresh failed: ${inspected.error.message}`,
        false,
        true,
        inspected.error,
      )
      if (!scheduled) {
        yield* writeHandoff(context, event.issueId, settleRepair(entry))
      }
      return
    }
    const settled = settleRepair(entry)
    const inspectedAt = yield* currentInstant
    yield* applyHandoffObservation(
      context,
      event.issueId,
      settled,
      inspected.value,
      inspectedAt,
      repairPermission(settled, { _tag: 'Succeeded', issue }),
      Option.some(event.attempt),
      true,
    )
    yield* context.persistHandoffs
  })

/**
 * The retry a normal continuation was waiting on: the issue is re-read, and the session continues
 * only while it is still active, routable, and inside the workflow's concurrency limits.
 */
const resumeContinuation = (
  context: OrchestratorContext,
  event: RetryDue,
  effective: EffectiveWorkflow,
  issue: Option.Option<Issue>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (Option.isNone(issue)) {
      yield* Ref.update(context.state, (pending) =>
        Transitions.releaseClaim(pending, event.issueId),
      )
      return
    }
    if (stateIsIn(issue.value.state, effective.workflow.config.tracker.terminalStates)) {
      yield* stopRetentionPass(context, event.issueId)
      yield* (
        context.durable === undefined
          ? effective.workspaces.remove(issue.value.identifier)
          : Effect.void
      ).pipe(
        Effect.zipRight(
          Ref.update(context.state, (pending) =>
            Transitions.forgetRetainedWorkspaces(pending, event.issueId),
          ),
        ),
        Effect.catchAll((error) =>
          logWarning('terminal workspace cleanup failed', {
            ...logContext(issue.value),
            action: 'workspace_cleanup',
            outcome: 'failed',
            error: error.message,
          }),
        ),
      )
      yield* Ref.update(context.state, (pending) =>
        Transitions.releaseClaim(pending, event.issueId),
      )
      return
    }
    if (
      !issueIsActive(issue.value, effective.workflow.config.tracker) ||
      !issueIsRoutable(issue.value, effective.workflow.config.tracker)
    ) {
      yield* Ref.update(context.state, (pending) =>
        Transitions.releaseClaim(pending, event.issueId),
      )
      return
    }
    const admitting = yield* Ref.get(context.state)
    if (!hasSlot(admitting, issue.value, effective.workflow)) {
      yield* context.scheduleRetry(
        issue.value,
        event.attempt + 1,
        'no available orchestrator slots',
        false,
        false,
      )
      return
    }
    yield* dispatch(context, issue.value, event.attempt)
  })

/**
 * A due retry the operator's pause has overtaken.
 *
 * The pause is read here, not only when it lands: this retry may have been queued after it, by the
 * publication the pause deliberately left to finish or by any other settlement on the issue. It is
 * read before the tracker refresh and before the repair split, so every retry queued behind a
 * pause — a continuation, a repair, one whose refresh would have failed — ends the way the pause
 * ends a retry it finds queued, rather than one path dispatching, one rescheduling, and one
 * carrying on with handoff actions.
 */
const endOvertakenRetry = (
  context: OrchestratorContext,
  event: RetryDue,
  issue: Issue,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const overtaken = yield* Ref.get(context.state)
    yield* endRetryForPause(
      context,
      event.issueId,
      Option.fromNullable(overtaken.handoffs.get(event.issueId)),
    )
    yield* logInfo('action=retry outcome=paused', {
      ...logContext(issue),
      action: 'retry',
      outcome: 'paused',
      attempt: event.attempt,
    })
    yield* recordOutcome(retryOutcomes, 'paused')
  })

/**
 * A queued retry coming due. Only the attempt that was scheduled may take it: a `RetryDue` for a
 * superseded attempt belongs to a timer that has since been replaced — and a retry the operator's
 * pause has overtaken is ended rather than resumed, whatever kind it was.
 */
export const onRetryDue = (context: OrchestratorContext, event: RetryDue): Effect.Effect<void> =>
  Effect.gen(function* () {
    const due = yield* Ref.modify(context.state, (current) =>
      Transitions.takeDueRetry(current, event.issueId, event.attempt),
    )
    if (Option.isNone(due)) {
      return
    }
    const taken = yield* Ref.get(context.state)
    if (issueIsPaused(taken, due.value.issue)) {
      yield* endOvertakenRetry(context, event, due.value.issue)
      return
    }
    if (yield* handoffTookOver(context, event.issueId)) {
      return
    }
    const current = yield* Ref.get(context.state)
    const effective = current.lastKnownGood
    const handoff = Option.fromNullable(current.handoffs.get(event.issueId))
    const repairHandoff = due.value.repairRun
      ? Option.filter(handoff, (entry) => Option.exists(entry.repair, (repair) => repair.inFlight))
      : Option.none<HandoffEntry>()
    const refreshTracker = Option.match(repairHandoff, {
      onNone: () => effective.tracker,
      onSome: (entry) => entry.execution.tracker,
    })
    const refreshResult = yield* refreshTracker.fetchIssuesByIds([event.issueId]).pipe(asSettled)
    if (refreshResult._tag === 'Failed') {
      const scheduled = yield* context.scheduleRetry(
        due.value.issue,
        event.attempt + 1,
        `retry refresh failed: ${refreshResult.error.message}`,
        false,
        due.value.repairRun,
        refreshResult.error,
      )
      if (!scheduled && Option.isSome(repairHandoff)) {
        yield* writeHandoff(context, event.issueId, settleRepair(repairHandoff.value))
      }
      return
    }
    const issue = Option.fromNullable(
      refreshResult.value.find((candidate) => candidate.id === event.issueId),
    )
    if (Option.isSome(repairHandoff)) {
      yield* resumeRepair(context, event, repairHandoff.value, issue)
      return
    }
    yield* resumeContinuation(context, event, effective, issue)
  })
