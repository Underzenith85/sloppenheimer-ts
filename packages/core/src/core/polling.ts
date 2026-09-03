import { Deferred, Effect, Queue, Ref } from 'effect'

import { currentInstant } from '../support/clock.js'
import { recordAgentStarted, recordPostflightStarted } from '../telemetry.js'
import * as Transitions from './transitions.js'
import type { OrchestratorContext, RunPhaseMarker } from './runtime.js'
import type { RuntimeState } from './state.js'
import { onAgentUpdate } from './polling/agent-update.js'
import { onDeliveryAttempted, onDeliveryDue } from './polling/delivery-due.js'
import { onIssuePauseChanged } from './polling/issue-pause.js'
import { onRebaseAttempted } from './polling/rebase.js'
import { onRetryDue } from './polling/retry-due.js'
import { onTick } from './polling/tick.js'
import { onWorkerExited } from './polling/worker-exited.js'

/**
 * The orchestrator's one host loop, and the reconciliation pass it drives.
 *
 * Everything that changes runtime state arrives here as a mailbox event, so the branches are
 * serialized against each other by construction: no transition can interleave with another, and no
 * consumer can read an index that disagrees with the scheduler it came from.
 *
 * Each branch is a handler of its own, taking the context and its own event:
 *
 * - `polling/tick.ts` — a polling tick, and the follow-up pass it may owe.
 * - `polling/agent-update.ts` — one protocol event from a live run.
 * - `polling/worker-exited.ts` — a worker fiber ending, and the handoff that may follow.
 * - `polling/retry-due.ts` — a queued retry coming due, continuing work or resuming a repair.
 * - `polling/delivery-due.ts` — a retained delivery's next publication attempt, with no agent.
 * - `polling/rebase.ts` — the host rebasing a pull request that fell behind the base, with no agent.
 * - `polling/issue-pause.ts` — the operator pausing or resuming an issue number.
 *
 * `polling/pass.ts` holds the reconciliation pass itself, and `polling/repair-identity.ts` the
 * durable handoff writes two of the handlers share.
 */

export { poll } from './polling/pass.js'

/**
 * Applies a marker of who is working on a run — the agent from here, or the host's postflight from
 * here — to the run and its detail together. Both or neither, and neither when the run is gone: a
 * cancellation can reach the loop while the worker is still waiting to be let past, and the worker
 * it belonged to is interrupted rather than going on, so a detail moved on here would sit in a
 * phase no settlement is ever coming to leave.
 */
const applyRunPhaseMarker = (
  state: RuntimeState,
  event: RunPhaseMarker,
  at: Date,
): RuntimeState => {
  switch (event._tag) {
    case 'AgentStarted': {
      return Transitions.agentStartApplies(state, event.issueId, event.runId)
        ? Transitions.updateDetail(
            Transitions.noteAgentStarted(state, event.issueId, event.runId, at),
            event.issueId,
            (record) => recordAgentStarted(record, at),
          )
        : state
    }
    case 'PostflightStarted': {
      return Transitions.postflightTakeoverApplies(state, event.issueId, event.runId)
        ? Transitions.updateDetail(
            Transitions.notePostflightStarted(state, event.issueId, event.runId, at),
            event.issueId,
            (record) => recordPostflightStarted(record, at),
          )
        : state
    }
  }
}

const onRunPhaseMarker = (
  context: OrchestratorContext,
  event: RunPhaseMarker,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const at = yield* currentInstant
    yield* Ref.update(context.state, (current) => applyRunPhaseMarker(current, event, at))
    // Only now may the worker go on: it is waiting on this, and what it is waiting for is the
    // state, not the message.
    yield* Deferred.succeed(event.applied, undefined)
  })

export const eventLoop = (context: OrchestratorContext): Effect.Effect<never> =>
  Effect.gen(function* () {
    for (;;) {
      const event = yield* Queue.take(context.mailbox)
      switch (event._tag) {
        case 'Tick': {
          yield* onTick(context)
          break
        }
        case 'AgentStarted':
        case 'PostflightStarted': {
          yield* onRunPhaseMarker(context, event)
          break
        }
        case 'AgentUpdate': {
          yield* onAgentUpdate(context, event)
          break
        }
        case 'WorkerExited': {
          yield* onWorkerExited(context, event)
          break
        }
        case 'RetryDue': {
          yield* onRetryDue(context, event)
          break
        }
        case 'DeliveryDue': {
          yield* onDeliveryDue(context, event)
          break
        }
        case 'DeliveryAttempted': {
          yield* onDeliveryAttempted(context, event)
          break
        }
        case 'RebaseAttempted': {
          yield* onRebaseAttempted(context, event)
          break
        }
        case 'SetIssuePaused': {
          yield* onIssuePauseChanged(context, event)
          break
        }
      }
      // Every transition of runtime state is followed by exactly one publication, so a consumer
      // never sees an index that disagrees with the scheduler it was derived from.
      yield* context.publish
    }
  })
