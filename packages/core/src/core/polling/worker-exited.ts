import { Clock, Effect, Option, Ref } from 'effect'

import { logError, logInfo } from '../../support/logging.js'
import { agentOutcomes, recordOutcome } from '../../support/observability.js'
import { settlePostflight } from '../delivery.js'
import { sessionLogContext } from '../policy.js'
import type { OrchestratorContext, OrchestratorEvent } from '../runtime.js'
import * as Transitions from '../transitions.js'

type WorkerExited = Extract<OrchestratorEvent, { _tag: 'WorkerExited' }>

/**
 * A worker fiber ending. The run leaves the running map first, so its buffered telemetry settles
 * and its detail stops counting itself down to stalled before anything slow happens.
 *
 * The turn's own outcome and what the host made of the workspace are settled separately, and in
 * that order. A protocol failure ends the run here; everything else is decided by the postflight,
 * because a turn that reported `completed` is not yet a claim that any work exists or that it
 * reached the remote.
 */
export const onWorkerExited = (
  context: OrchestratorContext,
  event: WorkerExited,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const ended = yield* Ref.modify(context.state, (current) =>
      Transitions.endRun(current, event.issueId, event.runId),
    )
    if (Option.isNone(ended)) {
      return
    }
    yield* recordOutcome(agentOutcomes, event.outcome)
    const settled = yield* Ref.modify(context.state, (current) =>
      Transitions.applyPendingTelemetry(current, event.issueId, ended.value),
    )
    const endedAt = yield* Clock.currentTimeMillis
    yield* Ref.update(context.state, (current) =>
      Transitions.accountEndedRun(current, settled, endedAt),
    )
    if (settled.sessionId !== null) {
      yield* (event.outcome === 'normal' ? logInfo : logError)(
        event.outcome === 'normal'
          ? 'action=session outcome=completed'
          : 'action=session outcome=failed',
        {
          ...sessionLogContext(settled),
          action: 'session',
          outcome: event.outcome === 'normal' ? 'completed' : 'failed',
          error: event.error,
        },
      )
    }
    if (event.outcome !== 'normal') {
      yield* context.scheduleRetry(
        settled.issue,
        (event.attempt ?? 0) + 1,
        event.error,
        false,
        settled.repairRun,
      )
      return
    }
    // The postflight owns everything from here: whether work exists, whether it is on the remote,
    // and therefore whether a pull request may be asked about at all. This is the first attempt at
    // delivering it, so any retry the outcome earns is the second.
    yield* settlePostflight(
      context,
      {
        issue: settled.issue,
        execution: settled.execution,
        attempt: event.attempt,
        repairRun: settled.repairRun,
      },
      event.postflight,
      1,
    )
  })
