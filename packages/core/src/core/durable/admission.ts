import { Clock, Effect, Option, Ref } from 'effect'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { DurableHost } from './live-journal.js'
import { retryMatches } from './retry-settlement.js'
import { journalFor, type Writer } from './run-journal.js'
import { admittedWorkflow } from './transition.js'

export const admission =
  (
    records: Ref.Ref<ReadonlyMap<string, DurableWorkflow>>,
    semaphore: Effect.Semaphore,
    persist: (next: DurableWorkflow, expected: number | null) => Effect.Effect<void>,
    write: Writer,
  ): DurableHost['start'] =>
  (issue, target, afterPublication = 'review') =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = (yield* Ref.get(records)).get(issue.id)
        const repair = target._tag === 'Repair'
        if (
          current !== undefined &&
          (current.intent !== 'active' ||
            !(
              retryMatches(current, target) ||
              (repair
                ? current.status._tag === 'Completed' ||
                  (current.status._tag === 'Waiting' && current.status.condition === 'review')
                : afterPublication === 'continuation' &&
                  current.status._tag === 'Waiting' &&
                  current.status.condition === 'continuation')
            ))
        ) {
          return Option.none()
        }
        const now = yield* Clock.currentTimeMillis
        if (
          current !== undefined &&
          (now >= current.budgetDeadline ||
            (repair
              ? current.repairAttempts >= current.maximumRepairAttempts
              : current.codingAttempts >= current.maximumCodingAttempts))
        ) {
          yield* persist(
            {
              ...current,
              revision: current.revision + 1,
              updatedAt: now,
              status: {
                _tag: 'Intervention',
                reason: 'The workflow coding, repair, or time budget is exhausted',
              },
            },
            current.revision,
          )
          return Option.none()
        }
        const next = admittedWorkflow(current, issue, target, afterPublication, now)
        yield* persist(next, current?.revision ?? null)
        return Option.some(journalFor(write, issue.id, next.owner))
      }),
    )
