import { Clock, Deferred, Effect, Fiber, Queue, Ref } from 'effect'

import { agentDetail, createSnapshot } from '../snapshot.js'
import { requestRefresh } from './scheduling.js'
import type { OrchestratorContext, OrchestratorControl, RuntimeCells } from './types.js'

/**
 * The handle the composition root holds: reads of the published state, and the two requests an
 * operator can make of a running host. Everything that changes state still goes through the
 * mailbox, so a console request takes its turn behind the scheduler rather than beside it.
 */
export const orchestratorControl = (
  cells: RuntimeCells,
  context: OrchestratorContext,
  eventLoopFiber: Fiber.RuntimeFiber<never>,
): OrchestratorControl => ({
  snapshot: Effect.map(
    Effect.all([Ref.get(cells.state), Clock.currentTimeMillis]),
    ([current, now]) => createSnapshot(current, context.selectedWorkflowPath, now),
  ),
  refresh: requestRefresh(cells),
  agentDetail: (identifier) => agentDetail(context, identifier),
  agentTrace: (identifier, query) => context.traces.page(identifier, query),
  agentTraceStream: (identifier) => context.traces.live(identifier),
  setIssuePaused: (issueNumber, paused) =>
    Effect.gen(function* () {
      const reply = yield* Deferred.make<void>()
      yield* Queue.offer(cells.mailbox, { _tag: 'SetIssuePaused', issueNumber, paused, reply })
      yield* Deferred.await(reply)
    }),
  awaitTermination: Fiber.join(eventLoopFiber).pipe(
    Effect.zipRight(Effect.dieMessage('orchestrator event loop exited unexpectedly')),
  ),
})
