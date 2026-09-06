import { Clock, Effect, Option, Ref } from 'effect'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { DurableHost } from './live-journal.js'
import { retryMatches } from './retry-settlement.js'
import { journalFor, type Writer } from './run-journal.js'
import { admittedWorkflow } from './transition.js'

/** Finds the durable owner of an issue across provider ID changes. */
export const durableWorkflowFor = (
  records: Iterable<DurableWorkflow>,
  issue: Readonly<{ id: string; identifier: string }>,
): DurableWorkflow | undefined =>
  [...records].find(
    (record) => record.issueId === issue.id || record.identifier === issue.identifier,
  )

export const admission =
  (
    records: Ref.Ref<ReadonlyMap<string, DurableWorkflow>>,
    semaphore: Effect.Semaphore,
    persist: (next: DurableWorkflow, expected: number | null) => Effect.Effect<void>,
    write: Writer,
  ): DurableHost['start'] =>
  (
    issue,
    target,
    afterPublication = 'review',
    verificationRequired = true,
    retryMismatch = 'reject',
  ) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const snapshot = yield* Ref.get(records)
        const current = snapshot.get(issue.id) ?? durableWorkflowFor(snapshot.values(), issue)
        const repair = target._tag === 'Repair'
        if (
          current !== undefined &&
          current.status._tag === 'Waiting' &&
          current.status.condition === 'retry' &&
          !retryMatches(current, target)
        ) {
          if (retryMismatch === 'reject') {
            return Option.none()
          }
          const now = yield* Clock.currentTimeMillis
          yield* persist(
            {
              ...current,
              revision: current.revision + 1,
              updatedAt: now,
              status: {
                _tag: 'Intervention',
                reason:
                  'Retry input changed before dispatch; reconcile the new head before another mutation',
              },
            },
            current.revision,
          )
          return Option.none()
        }
        if (
          current !== undefined &&
          (current.intent !== 'active' ||
            !(
              retryMatches(current, target) ||
              (repair
                ? current.status._tag === 'Completed' ||
                  (current.status._tag === 'Waiting' && current.status.condition === 'review')
                : current.status._tag === 'Waiting' && current.status.condition === 'continuation')
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
        const next = admittedWorkflow(
          current,
          issue,
          target,
          afterPublication,
          verificationRequired,
          now,
        )
        yield* persist(next, current?.revision ?? null)
        return Option.some(journalFor(write, issue.id, next.owner))
      }),
    )
