import { Clock, Effect, Ref } from 'effect'

import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { HandoffSnapshot } from '../../domain/handoff.js'
import type { Writer } from './run-journal.js'

/** Legacy evidence is imported once. Unknown execution never becomes a fabricated candidate. */
export const migratedHandoff = (handoff: HandoffSnapshot, now: number): DurableWorkflow => ({
  version: 1,
  issueId: handoff.issueId,
  identifier: handoff.identifier,
  objective: `Follow retained pull request ${handoff.pullRequestUrl}`,
  revision: 0,
  intent: 'active',
  verificationRequired: false,
  afterPublication: 'review',
  handoff,
  status:
    handoff.state === 'merged'
      ? { _tag: 'Completed', headSha: handoff.headSha }
      : handoff.repairStartedHeadSha !== null && handoff.repairStartedHeadSha !== undefined
        ? {
            _tag: 'Intervention',
            reason:
              'Legacy repair has uncertain execution; inspect retained work before continuing',
          }
        : { _tag: 'Waiting', condition: 'review', deadline: now + 86_400_000 },
  artifact: null,
  codingAttempts: 0,
  repairAttempts: handoff.repairAttempts,
  maximumCodingAttempts: 3,
  maximumRepairAttempts: 3,
  budgetDeadline: now + 86_400_000,
  lastProgressAt: now,
  lastFailureSignature: null,
  repeatedFailures: 0,
  updatedAt: now,
})

export const recordHandoffs = (
  records: Ref.Ref<ReadonlyMap<string, DurableWorkflow>>,
  semaphore: Effect.Semaphore,
  persist: (next: DurableWorkflow, expected: number | null) => Effect.Effect<void>,
  write: Writer,
  handoffs: readonly HandoffSnapshot[],
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const handoff of handoffs) {
      yield* semaphore.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* Ref.get(records)).has(handoff.issueId)) {
            yield* persist(migratedHandoff(handoff, yield* Clock.currentTimeMillis), null)
          }
        }),
      )
      const now = yield* Clock.currentTimeMillis
      yield* write(handoff.issueId, (current) => {
        if (JSON.stringify(current.handoff) === JSON.stringify(handoff)) {
          return current
        }
        const completed = handoff.state === 'merged'
        return {
          ...current,
          handoff,
          status: completed ? { _tag: 'Completed', headSha: handoff.headSha } : current.status,
          ...(completed && current.artifact !== null && current.cleanup === undefined
            ? {
                intent: 'cancelled' as const,
                cleanup: {
                  workspacePath: current.artifact.workspacePath,
                  workspaceKey: current.artifact.workspaceKey,
                  state: 'queued' as const,
                  attempts: 0,
                  dueAt: now,
                  reason: null,
                },
              }
            : {}),
        }
      })
    }
  })
