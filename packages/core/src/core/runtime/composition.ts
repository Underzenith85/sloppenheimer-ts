import { Effect, Option } from 'effect'

import type { Workflow } from '../../config/workflow.js'
import { WorkflowError } from '../../domain/errors.js'
import { WorkflowComposition, WorkflowStore } from '../../ports/workflow-store.js'

/** Refuse a second startup read that changes which authority the composition acquired. */
export const validateWorkflowComposition = (
  workflow: Workflow,
): Effect.Effect<void, WorkflowError> =>
  Effect.gen(function* () {
    const composed = yield* Effect.serviceOption(WorkflowComposition)
    if (Option.isNone(composed)) {
      return
    }
    const enabled = workflow.config.verification !== undefined
    const store = yield* Effect.serviceOption(WorkflowStore)
    if (enabled !== composed.value.verificationEnabled || (enabled && Option.isNone(store))) {
      return yield* Effect.fail(
        new WorkflowError({
          category: 'invalid_config',
          message:
            'Verification mode changed during startup or durable authority is missing; restart required',
        }),
      )
    }
  })
