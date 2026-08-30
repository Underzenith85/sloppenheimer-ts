import { Effect } from 'effect'

import { sameTrackerProvider } from '../config/tracker-config.js'
import { preflightWorkflow, type Workflow } from '../config/workflow.js'
import type { WorkflowError } from '../errors.js'
import type { TrackerAdapter } from '../tracker.js'
import type { EffectiveWorkflow, OrchestratorContext } from './runtime.js'

export const revalidateCredentials = (
  context: OrchestratorContext,
  effective: EffectiveWorkflow,
): Effect.Effect<EffectiveWorkflow, WorkflowError> =>
  preflightWorkflow(effective.workflow, context.dependencies.environment).pipe(
    Effect.map((validated) => {
      if (sameTrackerProvider(validated, effective.workflow.tracker)) {
        return effective
      }
      const workflow: Workflow = { ...effective.workflow, tracker: validated }
      return {
        ...effective,
        workflow,
        tracker: context.dependencies.makeTracker(workflow),
      }
    }),
  )

export const adoptTracker = (
  context: OrchestratorContext,
  previous: TrackerAdapter,
  next: TrackerAdapter,
): void => {
  for (const entry of [...context.state.running.values(), ...context.state.handoffs.values()]) {
    if (entry.execution.tracker === previous) {
      entry.execution = Object.freeze({
        ...entry.execution,
        tracker: next,
        secretEnvironmentNames: Object.freeze([...next.secretEnvironmentNames]),
      })
    }
  }
}
