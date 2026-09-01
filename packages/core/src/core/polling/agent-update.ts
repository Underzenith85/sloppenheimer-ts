import { Effect, Ref } from 'effect'

import { recordAgentEvent } from '../../telemetry.js'
import type { OrchestratorContext, OrchestratorEvent } from '../runtime.js'
import * as Transitions from '../transitions.js'

/**
 * One protocol event from a live run. The usage counters only ever rise, so a report that arrives
 * out of order cannot lower what the run already accounted for.
 */
export const onAgentUpdate = (
  context: OrchestratorContext,
  event: Extract<OrchestratorEvent, { _tag: 'AgentUpdate' }>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const observed = yield* Ref.get(context.state)
    const entry = observed.running.get(event.issueId)
    if (entry !== undefined) {
      const applied = yield* context.applyLifecycleUpdate(entry, event.update)
      yield* Ref.update(context.state, (current) => {
        const settled = Transitions.dropPendingLifecycle(
          Transitions.updateRun(current, event.issueId, () =>
            event.update.usage === null
              ? applied
              : {
                  ...applied,
                  lastReportedTokens: event.update.usage,
                  tokens: {
                    inputTokens: Math.max(
                      applied.tokens.inputTokens,
                      event.update.usage.inputTokens,
                    ),
                    outputTokens: Math.max(
                      applied.tokens.outputTokens,
                      event.update.usage.outputTokens,
                    ),
                    totalTokens: Math.max(
                      applied.tokens.totalTokens,
                      event.update.usage.totalTokens,
                    ),
                  },
                },
          ),
          event.issueId,
          event.update,
        )
        if (event.update.rateLimits === null) {
          return settled
        }
        return Transitions.clearPendingRateLimits(
          Transitions.mergeRateLimits(settled, event.update.rateLimits),
          event.update.rateLimits,
        )
      })
      // Only a live run contributes to the timeline: output from a worker the orchestrator
      // has already ended belongs to no attempt.
      yield* Ref.update(context.state, (current) =>
        Transitions.updateDetail(current, event.issueId, (record) =>
          recordAgentEvent(record, event.update),
        ),
      )
    }
  })
