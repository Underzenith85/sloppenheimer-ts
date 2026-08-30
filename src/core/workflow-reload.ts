import { Effect } from 'effect'

import { sameTrackerProvider } from '../domain/tracker-provider.js'
import { preflightWorkflow, type Workflow } from '../config/workflow.js'
import { WorkflowError } from '../errors.js'
import type { EffectiveWorkflow, OrchestratorContext } from './runtime.js'

export const revalidateCredentials = (
  context: OrchestratorContext,
  effective: EffectiveWorkflow,
): Effect.Effect<EffectiveWorkflow, WorkflowError> =>
  preflightWorkflow(effective.workflow, context.dependencies.environment).pipe(
    Effect.flatMap((validated) => {
      if (sameTrackerProvider(validated, effective.workflow.tracker)) {
        return Effect.succeed(effective)
      }
      const workflow: Workflow = { ...effective.workflow, tracker: validated }
      return Effect.try({
        try: () => {
          const codeReview = context.dependencies.makeCodeReview?.(workflow) ?? null
          if (context.dependencies.makeCodeReview !== undefined && codeReview === null) {
            throw new WorkflowError({
              category: 'invalid_config',
              message: `pull-request handoff is enabled, but tracker provider ${workflow.tracker.kind} does not supply CodeReviewPort`,
            })
          }
          return {
            ...effective,
            workflow,
            tracker: context.dependencies.makeTracker(workflow),
            codeReview,
          }
        },
        catch: (cause) =>
          cause instanceof WorkflowError
            ? cause
            : new WorkflowError({
                category: 'invalid_config',
                message: 'application ports could not be configured',
                cause,
              }),
      })
    }),
  )

export const adoptPorts = (
  context: OrchestratorContext,
  previous: EffectiveWorkflow,
  next: EffectiveWorkflow,
): void => {
  for (const entry of [...context.state.running.values(), ...context.state.handoffs.values()]) {
    if (entry.execution.tracker === previous.tracker) {
      entry.execution = Object.freeze({
        ...entry.execution,
        tracker: next.tracker,
        codeReview:
          entry.execution.codeReview === previous.codeReview
            ? next.codeReview
            : entry.execution.codeReview,
        secretEnvironmentNames: Object.freeze([...next.tracker.secretEnvironmentNames]),
      })
    }
  }
}
