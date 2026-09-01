import { Effect, Option, Ref, type Scope } from 'effect'

import { currentInstant } from '../../support/clock.js'
import { logInfo, logWarning } from '../../support/logging.js'
import { asSettled } from '../../support/settled.js'
import { recordPublication } from '../../telemetry.js'
import { settlePostflight } from '../delivery.js'
import { identifierIssueNumber, issueIsActive, logContext, stateIsIn } from '../policy.js'
import { runPostflight } from '../postflight.js'
import type { OrchestratorContext, OrchestratorEvent } from '../runtime.js'
import type { DeliveryEntry } from '../postflight.js'
import type { RuntimeState } from '../state.js'
import * as Transitions from '../transitions.js'

type DeliveryDue = Extract<OrchestratorEvent, { _tag: 'DeliveryDue' }>

/**
 * What is owed to a delivery that has come due.
 *
 * A delivery holds a claim with no worker behind it, so nothing else re-reads its issue while it
 * waits. It asks here, once, immediately before publishing.
 */
type DeliveryDisposition = 'publish' | 'discard' | 'hold'

/**
 * Whether the issue still wants this work delivered, and what to do if it does not.
 *
 * An operator pause holds the work: a pause is reversible, so nothing is published and nothing is
 * thrown away. An issue that has gone terminal or left its active states discards it: pushing a
 * branch and opening a pull request for work nobody asked for any more is worse than losing a diff,
 * and it is the one case the policy in `AGENTS.md` calls a discard.
 */
const dispositionOf = (
  state: RuntimeState,
  entry: DeliveryEntry,
): Effect.Effect<DeliveryDisposition> =>
  Effect.gen(function* () {
    const paused = Option.exists(identifierIssueNumber(entry.issue.identifier), (issueNumber) =>
      state.pausedIssueNumbers.has(issueNumber),
    )
    if (paused) {
      return 'hold'
    }
    const refreshed = yield* entry.execution.tracker
      .fetchIssuesByIds([entry.issue.id])
      .pipe(asSettled)
    if (refreshed._tag === 'Failed') {
      // The tracker is what could not be reached, not the remote. Publishing is still the right
      // thing to do: the work exists, and a tracker outage is not a decision about it.
      yield* logWarning('delivery issue refresh failed; publishing anyway', {
        ...logContext(entry.issue),
        action: 'delivery',
        outcome: 'refresh_failed',
        error: refreshed.error.message,
      })
      return 'publish'
    }
    const issue = refreshed.value.find((candidate) => candidate.id === entry.issue.id)
    if (issue === undefined) {
      return 'publish'
    }
    const execution = entry.execution
    return !stateIsIn(issue.state, execution.terminalStates) && issueIsActive(issue, execution)
      ? 'publish'
      : 'discard'
  })

/** Holds the work where it is, with nothing waiting to publish it until the pause is lifted. */
const holdDelivery = (context: OrchestratorContext, entry: DeliveryEntry): Effect.Effect<void> =>
  Effect.gen(function* () {
    const heldAt = yield* currentInstant
    yield* Ref.update(context.state, (current) =>
      Transitions.updateDetail(Transitions.holdDelivery(current, entry), entry.issue.id, (record) =>
        recordPublication(record, heldAt, {
          status: 'failed',
          branch: entry.prepared.target.branchName,
          baselineSha: entry.prepared.baselineSha,
          category: entry.failure.category,
          attempts: entry.attempt,
          message: `${entry.failure.message}. Delivery is held: the operator paused the issue`,
        }),
      ),
    )
    yield* logInfo('action=delivery outcome=suspended', {
      ...logContext(entry.issue),
      action: 'delivery',
      outcome: 'suspended',
      attempt: entry.attempt,
      branch: entry.prepared.target.branchName,
      error: 'the operator paused the issue',
    })
  })

/**
 * Discards the work with the workspace holding it, because the issue is finished with.
 *
 * The removal is what makes the discard true, so it happens before anything says so. A removal
 * that failed leaves the files exactly where they were: calling that discarded would report work
 * as gone while it sits on disk, waiting for the next agent on this issue to inherit it as its own.
 * The workspace goes back to being unexamined instead, which is what refuses that dispatch until a
 * pass has established what is in it.
 */
const discardDelivery = (context: OrchestratorContext, entry: DeliveryEntry): Effect.Effect<void> =>
  Effect.gen(function* () {
    const removed = yield* entry.execution.workspaces.remove(entry.issue.identifier).pipe(asSettled)
    const discardedAt = yield* currentInstant
    if (removed._tag === 'Failed') {
      yield* logWarning('delivery workspace cleanup failed; the work is still on disk', {
        ...logContext(entry.issue),
        action: 'workspace_cleanup',
        outcome: 'failed',
        error: removed.error.message,
      })
      yield* Ref.update(context.state, (current) =>
        Transitions.releaseClaim(
          Transitions.noteWorkspaceExamined(
            Transitions.updateDetail(current, entry.issue.id, (record) =>
              recordPublication(record, discardedAt, {
                status: 'failed',
                branch: entry.prepared.target.branchName,
                baselineSha: entry.prepared.baselineSha,
                category: entry.failure.category,
                attempts: entry.attempt,
                message: `The issue no longer wants this work, and the workspace holding it could not be removed: ${removed.error.message}`,
              }),
            ),
            entry.issue.id,
            false,
          ),
          entry.issue.id,
        ),
      )
      return
    }
    yield* Ref.update(context.state, (current) =>
      Transitions.releaseClaim(
        Transitions.updateDetail(current, entry.issue.id, (record) =>
          recordPublication(record, discardedAt, {
            status: 'not_performed',
            branch: entry.prepared.target.branchName,
            baselineSha: entry.prepared.baselineSha,
            attempts: entry.attempt,
            message: 'Unpublished work discarded: the issue no longer wants it',
          }),
        ),
        entry.issue.id,
      ),
    )
  })

/**
 * A retained delivery's next publication attempt.
 *
 * No agent runs and no attempt of the agent's is spent: this republishes the same preparation the
 * turn was launched against, and hands whatever comes back to the same settlement the turn's own
 * postflight went through.
 */
export const onDeliveryDue = (
  context: OrchestratorContext,
  event: DeliveryDue,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const due = yield* Ref.modify(context.state, (current) =>
      Transitions.takeDueDelivery(current, event.issueId, event.attempt),
    )
    if (Option.isNone(due)) {
      return
    }
    const entry = due.value
    const disposition = yield* dispositionOf(yield* Ref.get(context.state), entry)
    if (disposition === 'hold') {
      yield* holdDelivery(context, entry)
      return
    }
    if (disposition === 'discard') {
      yield* discardDelivery(context, entry)
      return
    }
    // Whichever instance the orchestrator holds now: a credential rotation between the failure and
    // this attempt is exactly the kind of thing that makes the retry worth having.
    const current = yield* Ref.get(context.state)
    const sourceControl = current.lastKnownGood.sourceControl ?? entry.execution.sourceControl
    if (sourceControl === null) {
      yield* logWarning('retained delivery has no source control to publish through', {
        ...logContext(entry.issue),
        action: 'delivery',
        outcome: 'abandoned',
        error: 'the workflow in force composes no source-control capability',
      })
      yield* Ref.update(context.state, (pending) =>
        Transitions.releaseClaim(pending, event.issueId),
      )
      return
    }
    const startedAt = yield* currentInstant
    yield* Ref.update(context.state, (pending) =>
      Transitions.updateDetail(pending, event.issueId, (record) =>
        recordPublication(record, startedAt, {
          status: 'pending',
          branch: entry.prepared.target.branchName,
          baselineSha: entry.prepared.baselineSha,
          attempts: entry.attempt,
          message: `Retrying delivery of the retained changes (attempt ${String(entry.attempt + 1)})`,
        }),
      ),
    )
    yield* context.publish
    const outcome = yield* runPostflight(sourceControl, entry.issue, entry.prepared)
    yield* logInfo('action=delivery outcome=attempted', {
      ...logContext(entry.issue),
      action: 'delivery',
      outcome: outcome._tag === 'DeliveryFailed' ? 'failed' : 'settled',
      attempt: entry.attempt,
      branch: entry.prepared.target.branchName,
      error: outcome._tag === 'DeliveryFailed' ? outcome.failure.message : null,
    })
    yield* settlePostflight(
      context,
      {
        issue: entry.issue,
        execution: entry.execution,
        attempt: entry.workerAttempt,
        repairRun: entry.repairRun,
      },
      outcome,
      entry.attempt + 1,
    )
  })
