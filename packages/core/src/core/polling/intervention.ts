import { Deferred, Effect, Option, Ref } from 'effect'

import { reconcileHandoffs } from '../handoff-reconciliation.js'
import { issuesForNumber } from '../policy.js'
import type { OrchestratorContext, OrchestratorEvent } from '../runtime.js'
import * as Transitions from '../transitions.js'

/**
 * Reconciles durable work before allowing an operator to retry it. This is deliberately a single
 * operation: an unchanged handoff is reset only after the current remote state has been checked,
 * and repair dispatch still goes through the normal exact-head and workspace checks.
 */
export const onInterventionResume = (
  context: OrchestratorContext,
  event: Extract<OrchestratorEvent, { _tag: 'ResumeIntervention' }>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const opening = yield* Ref.get(context.state)
    for (const id of issuesForNumber(opening.handoffs, event.issueNumber)) {
      yield* reconcileHandoffs(context, true, Option.some(id))
    }
    const reconciled = yield* Ref.get(context.state)
    for (const id of issuesForNumber(reconciled.deliveries, event.issueNumber)) {
      const delivery = reconciled.deliveries.get(id)
      if (delivery !== undefined && delivery.failure.retryable === false) {
        yield* context.resumeDelivery(delivery)
      }
    }
    const afterDelivery = yield* Ref.get(context.state)
    for (const id of issuesForNumber(afterDelivery.handoffs, event.issueNumber)) {
      const handoff = afterDelivery.handoffs.get(id)
      if (handoff?.state !== 'intervention_required') {
        continue
      }
      yield* Ref.update(context.state, (current) =>
        Transitions.resumeHandoffIntervention(current, id),
      )
      yield* reconcileHandoffs(context, true, Option.some(id))
    }
    yield* Deferred.succeed(event.reply, undefined)
  })
