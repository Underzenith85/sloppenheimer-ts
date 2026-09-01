import { Deferred, Effect, Fiber, Option, Ref } from 'effect'

import { currentInstant } from '../../support/clock.js'
import { recordCancellation } from '../../telemetry.js'
import { issuesForNumber } from '../policy.js'
import type { OrchestratorContext, OrchestratorEvent } from '../runtime.js'
import * as Transitions from '../transitions.js'
import { releaseHandoffRepair } from './repair-identity.js'

/**
 * The operator pausing or resuming an issue number. A pause ends whatever that number has running
 * or queued; a resume only lifts the bar, because what to dispatch next is the poll's decision.
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
        yield* context.cancelRunning(id, false, 'the operator paused the issue')
      }
      const retrying = yield* Ref.get(context.state)
      for (const id of issuesForNumber(retrying.retries, event.issueNumber)) {
        const retry = yield* Ref.modify(context.state, (current) =>
          Transitions.takeRetry(current, id),
        )
        if (Option.isNone(retry)) {
          continue
        }
        yield* Fiber.interrupt(retry.value.fiber)
        // An operator pause is a decision to stop, not an interruption to recover from:
        // the repair identity goes with the run the operator ended.
        yield* releaseHandoffRepair(context, id, Option.fromNullable(retrying.handoffs.get(id)))
        // Dropping the queued retry ends the agent, so its detail has to say so: without
        // this the record would publish as completed while still claiming to be waiting
        // to retry, and the retry it pointed at would never arrive.
        const cancelledAt = yield* currentInstant
        yield* Ref.update(context.state, (current) =>
          Transitions.updateDetail(Transitions.releaseClaim(current, id), id, (record) =>
            recordCancellation(record, cancelledAt, 'the operator paused the issue', true),
          ),
        )
      }
    } else {
      yield* Ref.update(context.state, (current) =>
        Transitions.resumeIssueNumber(current, event.issueNumber),
      )
    }
    yield* Deferred.succeed(event.reply, undefined)
  })
