import { Effect, Option, Ref } from 'effect'

import type { IssueId } from '../../domain/domain.js'
import { currentInstant } from '../../support/clock.js'
import { recordCancellation } from '../../telemetry.js'
import type { OrchestratorContext } from '../runtime.js'
import type { HandoffEntry } from '../state.js'
import * as Transitions from '../transitions.js'
import { releaseHandoffRepair } from './repair-identity.js'

/** The reason every record of an operator pause carries, so the console reads one thing for it. */
export const operatorPausedReason = 'the operator paused the issue'

/**
 * Ends a retry the operator's pause has overtaken, once the retry itself is out of the state.
 *
 * Two paths arrive here and end the same way. The pause landing finds a retry queued and drops it;
 * a retry coming due finds a pause that landed after it was queued — by the publication the pause
 * deliberately left to finish, or by any other settlement on the issue — and drops itself. In both
 * an agent that has not run has produced nothing to keep, so the claim is released rather than
 * held, the repair identity goes with the run the operator ended, and the detail says the agent
 * was cancelled rather than leaving it waiting for a retry that will never arrive.
 */
export const endRetryForPause = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: Option.Option<HandoffEntry>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* releaseHandoffRepair(context, id, handoff)
    const cancelledAt = yield* currentInstant
    yield* Ref.update(context.state, (current) =>
      Transitions.updateDetail(Transitions.releaseClaim(current, id), id, (record) =>
        recordCancellation(record, cancelledAt, operatorPausedReason, true),
      ),
    )
  })
