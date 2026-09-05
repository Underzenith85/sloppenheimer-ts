import { Effect, Option, Queue, Ref } from 'effect'

import { currentInstant } from '../../support/clock.js'
import { logInfo, logWarning } from '../../support/logging.js'
import { asSettled } from '../../support/settled.js'
import { recordPublication } from '../../telemetry.js'
import { settlePostflight } from '../delivery.js'
import { issueIsActive, issueIsPaused, logContext, stateIsIn } from '../policy.js'
import { publicationEligibility } from '../publication-eligibility.js'
import { runPostflight } from '../postflight.js'
import { stopRetentionPass } from '../run-workspace.js'
import { ownIssueFiber } from '../runtime/execution.js'
import type { OrchestratorContext, OrchestratorEvent } from '../runtime.js'
import type { DeliveryEntry } from '../postflight.js'
import type { DeliveryAttemptResult } from '../runtime.js'
import type { RuntimeState } from '../state.js'
import * as Transitions from '../transitions.js'

type DeliveryDue = Extract<OrchestratorEvent, { _tag: 'DeliveryDue' }>
type DeliveryAttempted = Extract<OrchestratorEvent, { _tag: 'DeliveryAttempted' }>

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
    if (issueIsPaused(state, entry.issue)) {
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
 * What is left when the removal that would make a discard true did not happen.
 *
 * Another attempt is worth having, and it has to be this delivery's: the manager that opened the
 * workspace is the only one that can remove it, a reload may since have moved the workspace root
 * out from under everything else, and retaining the delivery is what keeps that manager — and the
 * claim that stops an agent being sent at the issue meanwhile — alive to try again.
 *
 * When the attempts are spent the files stay where they are. The workspace goes back to being
 * unexamined, which refuses a dispatch into it until a pass has established what it holds, and the
 * operator has the reason in the issue's detail.
 */
const retryDiscard = (
  context: OrchestratorContext,
  entry: DeliveryEntry,
  error: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const retrying = yield* context.scheduleDelivery({
      issue: entry.issue,
      execution: entry.execution,
      prepared: entry.prepared,
      attempt: entry.attempt + 1,
      workerAttempt: entry.workerAttempt,
      failure: entry.failure,
      changedFileCount: entry.changedFileCount,
      repairRun: entry.repairRun,
    })
    const failedAt = yield* currentInstant
    yield* Ref.update(context.state, (current) => {
      // Written after the scheduling, so the reason an operator reads is the removal that failed
      // rather than the publication vocabulary the queueing records for itself.
      const noted = Transitions.updateDetail(current, entry.issue.id, (record) =>
        recordPublication(record, failedAt, {
          status: 'failed',
          branch: entry.prepared.target.branchName,
          baselineSha: entry.prepared.baselineSha,
          category: entry.failure.category,
          attempts: entry.attempt,
          message: retrying
            ? `The issue no longer wants this work, and the workspace holding it could not be removed: ${error}. Retrying the removal`
            : `The issue no longer wants this work, and the workspace holding it could not be removed: ${error}`,
        }),
      )
      return retrying ? noted : Transitions.releaseClaim(noted, entry.issue.id)
    })
  })

/**
 * Records a discard the attempt has already made true.
 *
 * The removal happened off the loop, in the attempt that reported `Discarded`; what is left is to
 * say so. Removing again here would be a second I/O call on the loop, and a second removal that
 * failed — an adapter whose removal is not idempotent — would report files remaining that the first
 * call deleted, retain the claim, and spend the delivery budget on work that no longer exists.
 */
const recordDiscarded = (context: OrchestratorContext, entry: DeliveryEntry): Effect.Effect<void> =>
  Effect.gen(function* () {
    const discardedAt = yield* currentInstant
    // The discard removed the issue's workspaces, retained ones included, so nothing is kept.
    yield* Ref.update(context.state, (current) =>
      Transitions.forgetRetainedWorkspaces(
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
        entry.issue.id,
      ),
    )
  })

/**
 * The publication attempt itself: a tracker re-read, and then git.
 *
 * Runs on its own fiber, off the event loop. Everything here can block for as long as a network
 * call can — a push waits on a child process that may never close — and the loop is the only thing
 * that can process a tick, a worker exit, or the operator pause that would call this off. One hung
 * push would otherwise freeze every issue the host is running.
 *
 * It decides nothing about the state. What it did comes back as an event, because the state is the
 * loop's to write and the handlers stay serialized.
 */
const runDeliveryAttempt = (
  context: OrchestratorContext,
  entry: DeliveryEntry,
): Effect.Effect<DeliveryAttemptResult> =>
  Effect.gen(function* () {
    const disposition = yield* dispositionOf(yield* Ref.get(context.state), entry)
    if (disposition === 'hold') {
      return { _tag: 'Held' } as const
    }
    if (disposition === 'discard' && context.durable !== undefined) {
      return { _tag: 'Held' } as const
    }
    if (disposition === 'discard') {
      yield* stopRetentionPass(context, entry.issue.id)
      const removed = yield* entry.execution.workspaces
        .remove(entry.issue.identifier)
        .pipe(asSettled)
      return removed._tag === 'Failed'
        ? ({ _tag: 'DiscardFailed', error: removed.error.message } as const)
        : ({ _tag: 'Discarded' } as const)
    }
    // The delivery's own. The execution snapshot is the record of what this work is published
    // under, and a reload that replaces the tracker moves every delivery holding it onto the
    // replacements, source control included — so the snapshot is already current when that is what
    // a retry needs. Reading the workflow in force instead agrees with it in every state the
    // transitions produce, and would disagree only in one they do not: a snapshot nothing adopted.
    const sourceControl = entry.execution.sourceControl
    if (sourceControl === null) {
      yield* logWarning('retained delivery has no source control to publish through', {
        ...logContext(entry.issue),
        action: 'delivery',
        outcome: 'abandoned',
        error: 'the workflow in force composes no source-control capability',
      })
      return { _tag: 'Abandoned' } as const
    }
    const outcome = yield* runPostflight(
      sourceControl,
      entry.issue,
      entry.prepared,
      entry.execution.workflow.config.verification,
      entry.execution.secretEnvironmentNames,
      publicationEligibility(context.state, entry.issue, entry.execution),
      entry.execution.journal?.publication,
    )
    yield* logInfo('action=delivery outcome=attempted', {
      ...logContext(entry.issue),
      action: 'delivery',
      outcome: outcome._tag === 'DeliveryFailed' ? 'failed' : 'settled',
      attempt: entry.attempt,
      branch: entry.prepared.target.branchName,
      error: outcome._tag === 'DeliveryFailed' ? outcome.failure.message : null,
    })
    return { _tag: 'Settled', outcome } as const
  })

/**
 * A retained delivery's next publication attempt.
 *
 * No agent runs and no attempt of the agent's is spent: this republishes the same preparation the
 * turn was launched against, and hands whatever comes back to the same settlement the turn's own
 * postflight went through.
 *
 * The attempt is forked rather than run here, and the delivery stays in the state while it runs —
 * claimed, published as a `delivering` row, and counted as handled by the recovery sweep — so that
 * a poll interleaving with the publication finds an issue something is demonstrably doing.
 */
export const onDeliveryDue = (
  context: OrchestratorContext,
  event: DeliveryDue,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pending = yield* Ref.get(context.state)
    const queued = pending.deliveries.get(event.issueId)
    if (queued === undefined || queued.attempt !== event.attempt) {
      return
    }
    const startedAt = yield* currentInstant
    yield* Ref.update(context.state, (current) =>
      Transitions.updateDetail(current, event.issueId, (record) =>
        recordPublication(record, startedAt, {
          status: 'pending',
          branch: queued.prepared.target.branchName,
          baselineSha: queued.prepared.baselineSha,
          attempts: queued.attempt,
          message: `Retrying delivery of the retained changes (attempt ${String(queued.attempt + 1)})`,
        }),
      ),
    )
    yield* context.publish
    // The publication takes over the issue's delivery key from the timer that has just fired, so
    // a pause or a discard arriving mid-attempt reaches the publication rather than a spent timer.
    yield* ownIssueFiber(
      context.execution,
      'delivery',
      event.issueId,
      Effect.flatMap(runDeliveryAttempt(context, queued), (result) =>
        Queue.offer(context.mailbox, {
          _tag: 'DeliveryAttempted' as const,
          issueId: event.issueId,
          attempt: event.attempt,
          result,
        }),
      ).pipe(Effect.asVoid),
    )
    yield* Ref.update(
      context.state,
      (current) =>
        Transitions.beginDeliveryAttempt(current, event.issueId, event.attempt, startedAt)[1],
    )
  })

/**
 * What the loop owes the attempt that has reported back.
 *
 * The delivery is taken out of the state here, at the one moment nothing is acting on it: a
 * `DeliveryAttempted` for an entry that has since been abandoned or superseded finds nothing and
 * settles nothing, which is what makes an interrupted attempt harmless.
 */
export const onDeliveryAttempted = (
  context: OrchestratorContext,
  event: DeliveryAttempted,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const due = yield* Ref.modify(context.state, (current) =>
      Transitions.takeAttemptedDelivery(current, event.issueId, event.attempt),
    )
    if (Option.isNone(due)) {
      return
    }
    const entry = due.value
    if (event.result._tag === 'Held') {
      yield* holdDelivery(context, entry)
      return
    }
    if (event.result._tag === 'DiscardFailed') {
      yield* logWarning('delivery workspace cleanup failed; the work is still on disk', {
        ...logContext(entry.issue),
        action: 'workspace_cleanup',
        outcome: 'failed',
        error: event.result.error,
      })
      yield* retryDiscard(context, entry, event.result.error)
      return
    }
    if (event.result._tag === 'Discarded') {
      yield* recordDiscarded(context, entry)
      return
    }
    if (event.result._tag === 'Abandoned') {
      // Nothing the host holds can publish this. The claim goes; the work stays on disk as the
      // run's retained workspace, which is what the workspace lifecycle keeps such artifacts as.
      yield* Ref.update(context.state, (current) =>
        Transitions.releaseClaim(current, entry.issue.id),
      )
      return
    }
    yield* entry.execution.journal?.settled(event.result.outcome) ?? Effect.void
    yield* settlePostflight(
      context,
      {
        issue: entry.issue,
        execution: entry.execution,
        attempt: entry.workerAttempt,
        repairRun: entry.repairRun,
      },
      event.result.outcome,
      entry.attempt + 1,
    )
  })
