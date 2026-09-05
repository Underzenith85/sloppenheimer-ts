import { Effect, Queue } from 'effect'

import { AgentError } from '../domain/errors.js'
import type { AgentLaunch, AgentResult, AgentRunnerPort } from '../ports/agent-runner.js'

/**
 * Agent silence belongs to the session's scope, never the tracker polling loop.
 * The callback wakes a bounded queue synchronously, so mailbox congestion cannot postpone a
 * deadline or attribute a wakeup to the next session. Preparation and hooks happen outside this.
 */
export const superviseAgent = (
  runner: AgentRunnerPort,
  launch: AgentLaunch,
): Effect.Effect<AgentResult, AgentError> => {
  if (launch.config.stallTimeoutMs <= 0) {
    return runner.run(launch)
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const activity = yield* Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown)
      const awaitSilence: Effect.Effect<never, AgentError> = Effect.forever(
        Queue.take(activity).pipe(
          Effect.timeoutFail({
            duration: launch.config.stallTimeoutMs,
            onTimeout: () =>
              new AgentError({
                category: 'turn_timeout',
                message: 'agent stalled',
              }),
          }),
        ),
      )
      return yield* Effect.raceFirst(
        runner.run({
          ...launch,
          onEvent: (event) => {
            Queue.unsafeOffer(activity, undefined)
            launch.onEvent(event)
          },
        }),
        awaitSilence,
      )
    }),
  )
}
