import { Clock, Deferred, Effect, Fiber, Option, Queue, Ref, type Scope } from 'effect'

import type { Issue } from '../domain/domain.js'
import type { TrackerError } from '../domain/errors.js'
import { currentInstant } from '../support/clock.js'
import { logInfo, logWarning } from '../support/logging.js'
import { recordCancellation, recordRetryScheduled } from '../telemetry.js'
import { agentRetryDelay, trackerRetryDelay } from './retry.js'
import type { OrchestratorContext, RefreshOutcome } from './runtime.js'
import type { RefreshOperation } from './state.js'
import * as Transitions from './transitions.js'

/**
 * When the orchestrator next takes a pass, and when an issue that failed takes its next attempt.
 *
 * Every operation here is stated against the context rather than closed over the factory's scope:
 * the state cell says what is already arranged, and the mailbox is what a timer fires into.
 */

/** Requests a tick, and says whether this request is the one that scheduled the pass. */
const offerTick = (
  context: OrchestratorContext,
  source: Transitions.TickSource,
): Effect.Effect<boolean> =>
  Ref.modify(context.state, (current) => Transitions.requestTick(current, source)).pipe(
    Effect.flatMap((decision) =>
      decision.enqueue
        ? Queue.offer(context.mailbox, { _tag: 'Tick' as const }).pipe(
            Effect.as(decision.scheduled),
          )
        : Effect.succeed(decision.scheduled),
    ),
  )

/** Asks the event loop for a pass, coalescing with one already arranged. */
export const requestTick = (
  context: OrchestratorContext,
  source: Transitions.TickSource,
): Effect.Effect<void> => Effect.asVoid(offerTick(context, source))

/**
 * Requests a poll pass and completes when that pass has finished, so a caller that reads the
 * snapshot afterwards sees the state the refresh produced.
 */
export const requestRefresh = (context: OrchestratorContext): Effect.Effect<RefreshOutcome> =>
  Effect.gen(function* () {
    const reply = yield* Deferred.make<readonly RefreshOperation[]>()
    const requestedAt = yield* currentInstant
    yield* Ref.update(context.state, (current) => Transitions.awaitRefresh(current, reply))
    const scheduled = yield* offerTick(context, 'change')
    // The pass answers with the stages it reached, so a validation failure that stopped it before
    // dispatch is not acknowledged as a dispatch.
    const operations = yield* Deferred.await(reply)
    return { coalesced: !scheduled, requestedAt: requestedAt.toISOString(), operations }
  })

/** Arms the polling timer, replacing whichever one the last pass left running. */
export const scheduleNextTick = (
  context: OrchestratorContext,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(context.state)
    if (current.pollTimer !== null) {
      yield* Fiber.interrupt(current.pollTimer)
    }
    const intervalMs = current.lastKnownGood.workflow.config.pollingIntervalMs
    const timer = yield* Effect.forkScoped(
      Effect.sleep(intervalMs).pipe(Effect.zipRight(requestTick(context, 'timer')), Effect.asVoid),
    )
    yield* Ref.update(context.state, (next) => Transitions.setPollTimer(next, timer))
  })

/**
 * Schedules the next attempt for an issue, and says whether one was scheduled at all. A tracker
 * error the retry policy calls terminal releases the claim instead of arming a timer.
 */
export const scheduleRetry = (
  context: OrchestratorContext,
  issue: Issue,
  attempt: number,
  error: string | null,
  continuation: boolean,
  trackerError?: TrackerError,
): Effect.Effect<boolean, never, Scope.Scope> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(context.state)
    const maximumMs = current.lastKnownGood.workflow.config.agent.maxRetryBackoffMs
    const delayOption = continuation
      ? Option.some(1_000)
      : trackerError === undefined
        ? Option.some(yield* agentRetryDelay(attempt, maximumMs))
        : yield* trackerRetryDelay(trackerError, attempt, maximumMs)
    if (Option.isNone(delayOption)) {
      const cancelledAt = yield* currentInstant
      const reason = error ?? 'the tracker rejected the retry'
      yield* Ref.update(context.state, (pending) =>
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
      return false
    }
    const delay = delayOption.value
    const dueAt = (yield* Clock.currentTimeMillis) + delay
    const fiber = yield* Effect.forkScoped(
      Effect.sleep(delay).pipe(
        Effect.zipRight(
          Queue.offer(context.mailbox, { _tag: 'RetryDue', issueId: issue.id, attempt }),
        ),
        Effect.asVoid,
      ),
    )
    const displaced = yield* Ref.modify(context.state, (pending) =>
      Transitions.scheduleRetry(pending, { issue, attempt, dueAt, error, fiber }),
    )
    if (Option.isSome(displaced)) {
      yield* Fiber.interrupt(displaced.value.fiber)
    }
    const scheduledAt = yield* currentInstant
    yield* Ref.update(context.state, (pending) =>
      Transitions.updateDetail(pending, issue.id, (record) =>
        recordRetryScheduled(record, scheduledAt, attempt, new Date(dueAt), error),
      ),
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
    return true
  })
