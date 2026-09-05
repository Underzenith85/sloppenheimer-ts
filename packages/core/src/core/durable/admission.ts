import { Clock, Effect, Option, Ref } from 'effect'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { DurableHost } from './live-journal.js'
import { retryMatches } from './retry-settlement.js'
import { journalFor, type Writer } from './run-journal.js'

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
        const revision = current === undefined ? 0 : current.revision + 1
        const owner = issue.id + ':run:' + String(revision)
        const next: DurableWorkflow = {
          version: 1,
          issueId: issue.id,
          identifier: issue.identifier,
          objective: issue.title,
          revision,
          owner,
          intent: 'active',
          afterPublication,
          runTarget: target,
          status: {
            _tag: 'Executing',
            deadline: now + 900_000,
            operation: {
              id: owner + ':prepare',
              generation: revision + 1,
              kind: 'prepare',
              inputRevision: repair ? target.expectedHeadSha : owner,
              attempt: 0,
              timeoutMs: 900_000,
            },
          },
          artifact: null,
          codingAttempts: (current?.codingAttempts ?? 0) + (repair ? 0 : 1),
          repairAttempts: (current?.repairAttempts ?? 0) + (repair ? 1 : 0),
          maximumCodingAttempts: current?.maximumCodingAttempts ?? 3,
          maximumRepairAttempts: current?.maximumRepairAttempts ?? 3,
          budgetDeadline: current?.budgetDeadline ?? now + 86_400_000,
          lastProgressAt: now,
          lastFailureSignature: null,
          repeatedFailures: 0,
          updatedAt: now,
        }
        yield* persist(next, current?.revision ?? null)
        return Option.some(journalFor(write, issue.id, owner))
      }),
    )
