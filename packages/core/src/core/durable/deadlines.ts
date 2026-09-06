import { Clock, Effect, Ref } from 'effect'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { Writer } from './run-journal.js'

/** A wait that outlives its budget becomes an actionable hold, never an endless polling loop. */
export const expireWaits = (
  records: Ref.Ref<ReadonlyMap<string, DurableWorkflow>>,
  write: Writer,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    for (const record of (yield* Ref.get(records)).values()) {
      if (
        record.status._tag !== 'Waiting' ||
        now < Math.min(record.status.deadline, record.budgetDeadline)
      ) {
        continue
      }
      yield* write(record.issueId, (current) =>
        current.revision !== record.revision
          ? current
          : {
              ...current,
              status: {
                _tag: 'Intervention',
                reason: `The ${record.status._tag === 'Waiting' ? record.status.condition : 'workflow'} wait deadline expired. Inspect retained evidence and decide whether to revise the objective or budget.`,
              },
            },
      )
    }
  })
