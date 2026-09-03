import { Deferred, Effect, Option, Ref } from 'effect'

import { issuesForNumber } from '../policy.js'
import { releaseIssueFiber } from '../runtime/execution.js'
import type { OrchestratorContext, OrchestratorEvent } from '../runtime.js'
import * as Transitions from '../transitions.js'
import { endRetryForPause, operatorPausedReason } from './paused-retry.js'

/**
 * The operator pausing or resuming an issue number. A pause ends whatever that number has running
 * or queued; a resume lifts the bar and arms whatever the pause was holding rather than discarding,
 * because what to dispatch next is the poll's decision.
 *
 * Work that already exists is the exception on both sides. A queued retry is dropped, because an
 * agent that has not run has produced nothing to keep; a delivery is only suspended, because the
 * change is in its workspace and a pause is a decision to stop, not to throw it away.
 */
export const onIssuePauseChanged = (
  context: OrchestratorContext,
  event: Extract<OrchestratorEvent, { _tag: 'SetIssuePaused' }>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (event.paused) {
      yield* Ref.update(context.state, (current) =>
        Transitions.pauseIssueNumber(current, event.issueNumber),
      )
      const paused = yield* Ref.get(context.state)
      for (const id of issuesForNumber(paused.running, event.issueNumber)) {
        yield* context.cancelRunning(id, false, operatorPausedReason)
      }
      const delivering = yield* Ref.get(context.state)
      for (const id of issuesForNumber(delivering.deliveries, event.issueNumber)) {
        yield* context.suspendDelivery(id, operatorPausedReason)
      }
      const retrying = yield* Ref.get(context.state)
      for (const id of issuesForNumber(retrying.retries, event.issueNumber)) {
        const retry = yield* Ref.modify(context.state, (current) =>
          Transitions.takeRetry(current, id),
        )
        if (Option.isNone(retry)) {
          continue
        }
        yield* releaseIssueFiber(context.execution, 'retry', id)
        yield* endRetryForPause(context, id, Option.fromNullable(retrying.handoffs.get(id)))
      }
    } else {
      yield* Ref.update(context.state, (current) =>
        Transitions.resumeIssueNumber(current, event.issueNumber),
      )
      const resumed = yield* Ref.get(context.state)
      for (const id of issuesForNumber(resumed.deliveries, event.issueNumber)) {
        const entry = resumed.deliveries.get(id)
        if (entry !== undefined && !entry.armed) {
          yield* context.resumeDelivery(entry)
        }
      }
    }
    yield* Deferred.succeed(event.reply, undefined)
  })
