import { Clock, Effect, Ref } from 'effect'
import type { Completion } from '../../domain/completion.js'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { Writer } from './run-journal.js'

/** Migration never manufactures a candidate or SHA from a legacy completion. */
export const recordCompletions = (
  records: Ref.Ref<ReadonlyMap<string, DurableWorkflow>>,
  semaphore: Effect.Semaphore,
  persist: (next: DurableWorkflow, expected: number | null) => Effect.Effect<void>,
  write: Writer,
  completions: readonly Completion[],
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const completion of completions) {
      yield* semaphore.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(records)).has(completion.issueId)) {
            return
          }
          const now = yield* Clock.currentTimeMillis
          yield* persist(
            {
              version: 1,
              issueId: completion.issueId,
              identifier: completion.identifier,
              objective: completion.title,
              revision: 0,
              intent: 'cancelled',
              verificationRequired: false,
              status: { _tag: 'Completed', headSha: null },
              completion,
              artifact: null,
              codingAttempts: 0,
              repairAttempts: 0,
              maximumCodingAttempts: 3,
              maximumRepairAttempts: 3,
              budgetDeadline: now,
              lastProgressAt: Date.parse(completion.finishedAt),
              lastFailureSignature: null,
              repeatedFailures: 0,
              updatedAt: now,
            },
            null,
          )
        }),
      )
      yield* write(completion.issueId, (current) => {
        if (
          current.completion !== undefined &&
          Date.parse(current.completion.finishedAt) >= Date.parse(completion.finishedAt)
        ) {
          return current
        }
        // History may coexist with a later run; importing it cannot cancel that new objective.
        return { ...current, completion }
      })
    }
  })
