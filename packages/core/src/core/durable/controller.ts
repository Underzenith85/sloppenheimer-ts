import { Clock, Effect, Option } from 'effect'

import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import { WorkflowStoreError } from '../../domain/errors.js'
import { WorkflowStore } from '../../ports/workflow-store.js'
import { transitionWorkflow, type WorkflowEvent } from './transition.js'

/**
 * The commit boundary precedes every emitted command. A conflict is reported to the caller so it
 * can re-read and reconsider; blindly replaying a decision made against stale inputs is unsafe.
 */
export const applyWorkflowEvent = (
  issueId: string,
  event: WorkflowEvent,
): Effect.Effect<DurableWorkflow, WorkflowStoreError, WorkflowStore> =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore
    const current = yield* store.get(issueId)
    if (Option.isNone(current)) {
      return yield* Effect.fail(
        new WorkflowStoreError({
          category: 'conflict',
          message: 'workflow does not exist',
        }),
      )
    }
    const next = transitionWorkflow(current.value, event, yield* Clock.currentTimeMillis)
    if (next !== current.value) {
      yield* store.commit(next, current.value.revision)
    }
    return next
  })

/** Restart never assumes that an in-flight operation failed before its external effect happened. */
export const reconcileInterruptedWorkflows: Effect.Effect<void, WorkflowStoreError, WorkflowStore> =
  Effect.gen(function* () {
    const store = yield* WorkflowStore
    const workflows = yield* store.list
    for (const workflow of workflows) {
      yield* applyWorkflowEvent(workflow.issueId, { _tag: 'Recovered' })
    }
  })
