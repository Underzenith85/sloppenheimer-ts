import { Deferred, Effect, Option, Ref } from 'effect'

import { reconcileHandoffs } from '../handoff-reconciliation.js'
import { identifierIssueNumber } from '../policy.js'
import type { HandoffEntry } from '../state.js'
import type { OrchestratorContext, OrchestratorEvent } from '../runtime.js'
import * as Transitions from '../transitions.js'

const matchesIssueNumber = (identifier: string, issueNumber: number): boolean =>
  Option.contains(identifierIssueNumber(identifier), issueNumber)

/** Opens one fresh, bounded repair window without changing the head the repair must lease. */
export const retryHandoffIntervention = (handoff: HandoffEntry): HandoffEntry => ({
  ...handoff,
  state: 'repair_needed',
  reason: 'Operator requested another bounded repair attempt.',
  repairHeadShas: [],
  repairObservedHeadShas: handoff.headSha === null ? [] : [handoff.headSha],
  repair: Option.none(),
  rebase: Option.none(),
})

export const onResumeIntervention = (
  context: OrchestratorContext,
  event: Extract<OrchestratorEvent, { _tag: 'ResumeIntervention' }>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const opening = yield* Ref.get(context.state)
    const delivery = [...opening.deliveries.values()].find(
      (entry) =>
        matchesIssueNumber(entry.issue.identifier, event.issueNumber) && !entry.failure.retryable,
    )
    if (delivery !== undefined) {
      yield* context.resumeDelivery(delivery)
      yield* Deferred.succeed(event.reply, {
        status: 'resumed',
        kind: 'delivery',
        reason: 'Retained publication recovery was resumed.',
      })
      return
    }

    const candidate = [...opening.handoffs].find(
      ([, handoff]) =>
        matchesIssueNumber(handoff.issue.identifier, event.issueNumber) &&
        handoff.state === 'intervention_required',
    )
    if (candidate === undefined) {
      yield* Deferred.succeed(event.reply, {
        status: 'refused',
        kind: null,
        reason: 'No intervention-required delivery or handoff exists for this issue.',
      })
      return
    }
    const [id] = candidate
    // Observe first with dispatch disabled. A merge, close, or human-pushed head is reconciled
    // before the operator action can replay work against the retained head.
    yield* reconcileHandoffs(context, false, Option.some(id))
    const reconciled = (yield* Ref.get(context.state)).handoffs.get(id)
    if (reconciled === undefined || reconciled.state !== 'intervention_required') {
      yield* Deferred.succeed(event.reply, {
        status: 'reconciled',
        kind: 'handoff',
        reason: 'The handoff changed while reconciling; its current state was kept.',
      })
      return
    }
    yield* Ref.update(context.state, (current) =>
      Transitions.putHandoff(current, id, retryHandoffIntervention(reconciled)),
    )
    yield* context.persistHandoffs
    yield* reconcileHandoffs(context, true, Option.some(id))
    yield* Deferred.succeed(event.reply, {
      status: 'resumed',
      kind: 'handoff',
      reason: 'A bounded handoff recovery attempt was requested.',
    })
  })
