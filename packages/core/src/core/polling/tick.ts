import { Deferred, Effect, Queue, Ref, type Scope } from 'effect'

import type { OrchestratorContext } from '../runtime.js'
import * as Transitions from '../transitions.js'
import { poll } from './pass.js'

/**
 * A polling tick: one pass, then whatever the pass owes. Callers waiting on a refresh are answered
 * with the stages the pass actually reached, and a change that landed while it ran turns straight
 * into the next tick rather than waiting out the interval.
 */
export const onTick = (context: OrchestratorContext): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Ref.update(context.state, Transitions.beginPoll)
    const performed = yield* poll(context)
    const waiters = yield* Ref.modify(context.state, Transitions.takeRefreshWaiters)
    yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, performed), {
      discard: true,
    })
    const finished = yield* Ref.modify(context.state, Transitions.finishPoll)
    if (finished.followUp) {
      yield* Ref.update(context.state, Transitions.promoteRefreshWaiters)
      yield* Queue.offer(context.mailbox, { _tag: 'Tick' })
      return
    }
    yield* context.scheduleNextTick
  })
