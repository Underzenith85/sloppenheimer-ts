import { Deferred, Effect, Queue, Ref } from 'effect'

import { currentInstant } from '../support/clock.js'
import { recordPostflightStarted } from '../telemetry.js'
import * as Transitions from './transitions.js'
import type { OrchestratorContext } from './runtime.js'
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

export const eventLoop = (context: OrchestratorContext): Effect.Effect<never> =>
  Effect.gen(function* () {
    for (;;) {
      const event = yield* Queue.take(context.mailbox)
      switch (event._tag) {
        case 'Tick': {
          yield* onTick(context)
          break
        }
        case 'PostflightStarted': {
          const startedAt = yield* currentInstant
          yield* Ref.update(context.state, (current) =>
            // Both or neither, and neither when the run is gone. A cancellation can reach the loop
            // while the worker is still waiting to be let past, and the worker it belonged to is
            // interrupted rather than publishing — so a detail moved to `publishing` here would sit
            // in a phase no settlement is ever coming to leave.
            Transitions.postflightTakeoverApplies(current, event.issueId, event.runId)
              ? Transitions.updateDetail(
                  Transitions.notePostflightStarted(current, event.issueId, event.runId, startedAt),
                  event.issueId,
                  (record) => recordPostflightStarted(record, startedAt),
                )
              : current,
          )
          // Only now may the publication begin: the worker is waiting on this, and what it is
          // waiting for is the state, not the message.
          yield* Deferred.succeed(event.applied, undefined)
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
        case 'RetainedWorkspacesObserved': {
          const observedAt = yield* currentInstant
          yield* Ref.update(context.state, (current) =>
            Transitions.recordRetainedWorkspaces(current, { ...event, observedAt }, event.runId),
          )
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
