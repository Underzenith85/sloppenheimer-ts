import { Clock, Effect } from 'effect'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { WorkflowStoreError } from '../../domain/errors.js'
import type { WorkflowStorePort } from '../../ports/workflow-store.js'

/** A host lock proves host exclusion, never the death of a previously detached command. */
export const restoreWorkflows = (
  store: WorkflowStorePort,
): Effect.Effect<readonly DurableWorkflow[], WorkflowStoreError> =>
  Effect.gen(function* () {
    const records = yield* store.list
    const now = yield* Clock.currentTimeMillis
    return yield* Effect.forEach(records, (record) => {
      if (
        record.status._tag === 'Completed' ||
        record.status._tag === 'Intervention' ||
        (record.status._tag === 'Waiting' &&
          (record.status.condition === 'continuation' ||
            (record.artifact?.publishedHead !== null &&
              record.artifact?.publishedHead !== undefined)))
      ) {
        return Effect.succeed(record)
      }
      const restored: DurableWorkflow = {
        ...record,
        revision: record.revision + 1,
        updatedAt: now,
        status: {
          _tag: 'Intervention',
          reason:
            'Host restarted with unfinished work. Confirm the previous command has stopped and inspect the retained candidate before recovery.',
        },
      }
      return store.commit(restored, record.revision).pipe(Effect.as(restored))
    })
  })
