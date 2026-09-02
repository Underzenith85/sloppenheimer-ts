import { Clock, Deferred, Effect, Option, Queue, Ref } from 'effect'

import type { Issue } from '../../domain/domain.js'
import type { TrackerError } from '../../domain/errors.js'
import { currentInstant } from '../../support/clock.js'
import { logInfo, logWarning } from '../../support/logging.js'
import { recordOutcome, retryOutcomes } from '../../support/observability.js'
import { recordCancellation, recordRetryScheduled } from '../../telemetry.js'
import { agentRetryDelay, trackerRetryDelay } from '../retry.js'
import type { RefreshOperation } from '../state.js'
import * as Transitions from '../transitions.js'
import { ownIssueFiber, ownPollTimer } from './execution.js'
import { traceRetryScheduled } from './traces.js'
import type { RefreshOutcome, RuntimeCells } from './types.js'

/** Requests a tick, and says whether this request is the one that scheduled the pass. */
const offerTick = (cells: RuntimeCells, source: Transitions.TickSource): Effect.Effect<boolean> =>
  Ref.modify(cells.state, (current) => Transitions.requestTick(current, source)).pipe(
    Effect.flatMap((decision) =>
      decision.enqueue
        ? Queue.offer(cells.mailbox, { _tag: 'Tick' as const }).pipe(Effect.as(decision.scheduled))
        : Effect.succeed(decision.scheduled),
    ),
  )

export const requestTick = (
  cells: RuntimeCells,
  source: Transitions.TickSource,
): Effect.Effect<void> => Effect.asVoid(offerTick(cells, source))

/**
 * Requests a poll pass and waits for the pass that answers it, so a caller that reads the snapshot
 * afterwards sees the state the refresh produced.
 */
export const requestRefresh = (cells: RuntimeCells): Effect.Effect<RefreshOutcome> =>
  Effect.gen(function* () {
    const reply = yield* Deferred.make<readonly RefreshOperation[]>()
    const requestedAt = yield* currentInstant
    yield* Ref.update(cells.state, (current) => Transitions.awaitRefresh(current, reply))
    const scheduled = yield* offerTick(cells, 'change')
    // The pass answers with the stages it reached, so a validation failure that stopped it before
    // dispatch is not acknowledged as a dispatch.
    const operations = yield* Deferred.await(reply)
    return { coalesced: !scheduled, requestedAt: requestedAt.toISOString(), operations }
  })

/**
 * Arms the polling timer. The execution owner holds one poll timer, so arming this pass interrupts
 * whatever the previous interval had pending rather than leaving two ticks to race.
 */
export const scheduleNextTick = (cells: RuntimeCells): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(cells.state)
    const intervalMs = current.lastKnownGood.workflow.config.pollingIntervalMs
    yield* ownPollTimer(
      cells.execution,
      Effect.sleep(intervalMs).pipe(Effect.zipRight(requestTick(cells, 'timer')), Effect.asVoid),
    )
  })

/**
 * Queues the next attempt for an issue, and says whether one was queued at all. A tracker error the
 * retry policy calls final cancels the claim instead, so the issue is released rather than held by
 * a retry that will never come due.
 */
export const scheduleRetry = (
  cells: RuntimeCells,
  issue: Issue,
  attempt: number,
  error: string | null,
  continuation: boolean,
  repairRun: boolean,
  trackerError?: TrackerError,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(cells.state)
    const maximumMs = current.lastKnownGood.workflow.config.agent.maxRetryBackoffMs
    const delayOption = continuation
      ? Option.some(1_000)
      : trackerError === undefined
        ? Option.some(yield* agentRetryDelay(attempt, maximumMs))
        : yield* trackerRetryDelay(trackerError, attempt, maximumMs)
    if (Option.isNone(delayOption)) {
      yield* abandonRetry(cells, issue, attempt, error)
      return false
    }
    const delay = delayOption.value
    const dueAt = (yield* Clock.currentTimeMillis) + delay
    // The issue owns one retry timer, so arming this attempt is what interrupts the attempt it
    // supersedes: there is no second registry a displaced timer could be left behind in.
    yield* ownIssueFiber(
      cells.execution,
      'retry',
      issue.id,
      Effect.sleep(delay).pipe(
        Effect.zipRight(
          Queue.offer(cells.mailbox, { _tag: 'RetryDue', issueId: issue.id, attempt }),
        ),
        Effect.asVoid,
      ),
    )
    yield* Ref.update(cells.state, (pending) =>
      Transitions.scheduleRetry(pending, { issue, attempt, repairRun, dueAt, error }),
    )
    const scheduledAt = yield* currentInstant
    yield* Ref.update(cells.state, (pending) =>
      Transitions.updateDetail(pending, issue.id, (record) =>
        recordRetryScheduled(record, scheduledAt, attempt, new Date(dueAt), error),
      ),
    )
    yield* traceRetryScheduled(
      cells.traces,
      issue.id,
      attempt,
      new Date(dueAt).toISOString(),
      error,
    )
    yield* logInfo('action=retry outcome=scheduled', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      action: 'retry',
      outcome: 'scheduled',
      attempt,
      due_at: new Date(dueAt).toISOString(),
      error,
    })
    yield* recordOutcome(retryOutcomes, 'scheduled')
    return true
  })

/** Releases the claim for an attempt the retry policy refused to schedule. */
const abandonRetry = (
  cells: RuntimeCells,
  issue: Issue,
  attempt: number,
  error: string | null,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const cancelledAt = yield* currentInstant
    const reason = error ?? 'the tracker rejected the retry'
    yield* Ref.update(cells.state, (pending) =>
      Transitions.updateDetail(Transitions.releaseClaim(pending, issue.id), issue.id, (record) =>
        recordCancellation(record, cancelledAt, reason, true),
      ),
    )
    yield* logWarning('action=retry outcome=not_retryable', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      action: 'retry',
      outcome: 'not_retryable',
      attempt,
      error,
    })
    yield* recordOutcome(retryOutcomes, 'not_retryable')
  })
