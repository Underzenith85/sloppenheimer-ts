import { Effect, Option, Ref, type Scope } from 'effect'

import { currentInstant } from '../../support/clock.js'
import { logInfo, logWarning } from '../../support/logging.js'
import { asSettled } from '../../support/settled.js'
import { recordPublication } from '../../telemetry.js'
import { settlePostflight } from '../delivery.js'
import { logContext, issueIsActive, stateIsIn } from '../policy.js'
import { runPostflight } from '../postflight.js'
import type { OrchestratorContext, OrchestratorEvent } from '../runtime.js'
import type { DeliveryEntry } from '../state.js'
import * as Transitions from '../transitions.js'

type DeliveryDue = Extract<OrchestratorEvent, { _tag: 'DeliveryDue' }>

/**
 * Whether the issue still wants this work delivered.
 *
 * A delivery holds a claim with no worker behind it, so nothing else re-reads the issue while it
 * waits. It asks here, once, immediately before publishing: pushing work for an issue that has
 * since been closed would put a branch and a pull request on the remote that no operator asked
 * for, and is the one case where retained work is discarded rather than preserved.
 */
const issueStillWantsDelivery = (entry: DeliveryEntry): Effect.Effect<boolean> =>
  Effect.gen(function* () {
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
      return true
    }
    const issue = refreshed.value.find((candidate) => candidate.id === entry.issue.id)
    if (issue === undefined) {
      return true
    }
    const execution = entry.execution
    return !stateIsIn(issue.state, execution.terminalStates) && issueIsActive(issue, execution)
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
    if (!(yield* issueStillWantsDelivery(entry))) {
      const discardedAt = yield* currentInstant
      yield* Ref.update(context.state, (current) =>
        Transitions.releaseClaim(
          Transitions.updateDetail(current, event.issueId, (record) =>
            recordPublication(record, discardedAt, {
              status: 'not_performed',
              branch: entry.prepared.target.branchName,
              baselineSha: entry.prepared.baselineSha,
              attempts: entry.attempt,
              message: 'Unpublished work discarded: the issue no longer wants it',
            }),
          ),
          event.issueId,
        ),
      )
      yield* entry.execution.workspaces.remove(entry.issue.identifier).pipe(
        Effect.catchAll((error) =>
          logWarning('delivery workspace cleanup failed', {
            ...logContext(entry.issue),
            action: 'workspace_cleanup',
            outcome: 'failed',
            error: error.message,
          }),
        ),
      )
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
