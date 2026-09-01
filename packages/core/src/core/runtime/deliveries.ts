import { Clock, Effect, Fiber, Option, Queue, Ref, type Scope } from 'effect'

import type { IssueId } from '../../domain/domain.js'
import { currentInstant } from '../../support/clock.js'
import { logInfo, logWarning } from '../../support/logging.js'
import { recordPublication } from '../../telemetry.js'
import { logContext } from '../policy.js'
import { agentRetryDelay, deliveryAttemptLimit } from '../retry.js'
import * as Transitions from '../transitions.js'
import type { DeliveryRequest, RuntimeCells } from './types.js'

/**
 * Queueing and abandoning work that is waiting to reach the remote.
 *
 * A delivery is not a retry in the sense `scheduling.ts` means: no agent runs, no agent attempt
 * moves, and the worktree is left exactly as the turn left it. What is queued is one more `publish`
 * of the same preparation, which is the whole difference between recovering a delivery and paying
 * for the turn again.
 */

/**
 * Queues another publication attempt for work an agent has already produced.
 *
 * Answers whether a delivery was queued. `false` means the work cannot be delivered as it stands —
 * the failure did not preserve the worktree, or the attempts are spent — and the caller owes the
 * issue whatever it would have owed a failed run.
 */
export const scheduleDelivery = (
  cells: RuntimeCells,
  request: DeliveryRequest,
): Effect.Effect<boolean, never, Scope.Scope> =>
  Effect.gen(function* () {
    const branchName = request.prepared.target.branchName
    const refusal = !request.failure.worktreePreserved
      ? 'the failure did not preserve the worktree'
      : !request.failure.retryable
        ? 'the failure is not retryable'
        : request.attempt > deliveryAttemptLimit
          ? `the delivery attempt limit of ${String(deliveryAttemptLimit)} is spent`
          : null
    if (refusal !== null) {
      yield* logWarning('action=delivery outcome=not_retryable', {
        ...logContext(request.issue),
        action: 'delivery',
        outcome: 'not_retryable',
        attempt: request.attempt,
        branch: branchName,
        error: `${request.failure.message} (${refusal})`,
      })
      return false
    }
    const current = yield* Ref.get(cells.state)
    const delay = yield* agentRetryDelay(
      request.attempt,
      current.lastKnownGood.workflow.config.agent.maxRetryBackoffMs,
    )
    const dueAt = (yield* Clock.currentTimeMillis) + delay
    const fiber = yield* Effect.forkScoped(
      Effect.sleep(delay).pipe(
        Effect.zipRight(
          Queue.offer(cells.mailbox, {
            _tag: 'DeliveryDue',
            issueId: request.issue.id,
            attempt: request.attempt,
          }),
        ),
        Effect.asVoid,
      ),
    )
    const observedAt = yield* currentInstant
    const displaced = yield* Ref.modify(cells.state, (pending) =>
      Transitions.scheduleDelivery(pending, { ...request, dueAt, observedAt, fiber }),
    )
    if (Option.isSome(displaced)) {
      yield* Fiber.interrupt(displaced.value.fiber)
    }
    yield* Ref.update(cells.state, (pending) =>
      Transitions.updateDetail(pending, request.issue.id, (record) =>
        recordPublication(record, observedAt, {
          status: 'failed',
          branch: branchName,
          baselineSha: request.prepared.baselineSha,
          category: request.failure.category,
          attempts: request.attempt,
          message: `${request.failure.message}. Retrying delivery at ${new Date(dueAt).toISOString()}`,
        }),
      ),
    )
    yield* logInfo('action=delivery outcome=scheduled', {
      ...logContext(request.issue),
      action: 'delivery',
      outcome: 'scheduled',
      attempt: request.attempt,
      branch: branchName,
      due_at: new Date(dueAt).toISOString(),
      error: request.failure.message,
    })
    return true
  })

/**
 * Drops a retained delivery, interrupting the attempt it was waiting on.
 *
 * Called only where the documented policy says unpublished work is discarded rather than
 * preserved: an issue that reached a terminal state, whose workspace goes with it. Everywhere else
 * the delivery outlives the event, which is what lets the work survive a cancellation.
 */
export const abandonDelivery = (
  cells: RuntimeCells,
  id: IssueId,
  reason: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dropped = yield* Ref.modify(cells.state, (current) =>
      Transitions.takeDelivery(current, id),
    )
    if (Option.isNone(dropped)) {
      return
    }
    yield* Fiber.interrupt(dropped.value.fiber)
    const observedAt = yield* currentInstant
    yield* Ref.update(cells.state, (current) =>
      Transitions.updateDetail(current, id, (record) =>
        recordPublication(record, observedAt, {
          status: 'not_performed',
          branch: dropped.value.prepared.target.branchName,
          baselineSha: dropped.value.prepared.baselineSha,
          attempts: dropped.value.attempt,
          message: `Unpublished work discarded: ${reason}`,
        }),
      ),
    )
    yield* logWarning('action=delivery outcome=discarded', {
      ...logContext(dropped.value.issue),
      action: 'delivery',
      outcome: 'discarded',
      attempt: dropped.value.attempt,
      branch: dropped.value.prepared.target.branchName,
      error: reason,
    })
  })
