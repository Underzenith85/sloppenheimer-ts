import { Effect, Queue, type Scope } from 'effect'

import type { OrchestratorContext } from './runtime.js'
import { onAgentUpdate } from './polling/agent-update.js'
import { onIssuePauseChanged } from './polling/issue-pause.js'
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
 * - `polling/issue-pause.ts` — the operator pausing or resuming an issue number.
 *
 * `polling/pass.ts` holds the reconciliation pass itself, and `polling/repair-identity.ts` the
 * durable handoff writes two of the handlers share.
 */

export { poll } from './polling/pass.js'

export const eventLoop = (context: OrchestratorContext): Effect.Effect<never, never, Scope.Scope> =>
  Effect.gen(function* () {
    for (;;) {
      const event = yield* Queue.take(context.mailbox)
      switch (event._tag) {
        case 'Tick': {
          yield* onTick(context)
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
