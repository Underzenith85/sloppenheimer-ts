import { changeIssueIntent, resumeIntervention } from './intent.js'
import type { WorkflowError } from '../../domain/errors.js'
import { Clock, Effect, Fiber, Ref } from 'effect'

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
  eventLoopFiber: Fiber.RuntimeFiber<never, WorkflowError>,
): OrchestratorControl => ({
  snapshot: Effect.map(
    Effect.all([Ref.get(cells.state), Clock.currentTimeMillis, cells.durable.snapshot]),
    ([current, now, durableWorkflows]) => ({
      ...createSnapshot(current, context.selectedWorkflowPath, now),
      durableWorkflows,
    }),
  ),
  refresh: Effect.raceFirst(requestRefresh(cells), Fiber.join(eventLoopFiber).pipe(Effect.orDie)),
  agentDetail: (identifier) => agentDetail(context, identifier),
  setIssuePaused: (issueNumber, paused) => changeIssueIntent(cells, issueNumber, paused),
  resumeIntervention: (issueNumber) =>
    Effect.raceFirst(
      resumeIntervention(cells, issueNumber),
      Fiber.join(eventLoopFiber).pipe(Effect.orDie),
    ),
  awaitTermination: Fiber.join(eventLoopFiber).pipe(
    Effect.zipRight(Effect.dieMessage('orchestrator event loop exited unexpectedly')),
  ),
})
