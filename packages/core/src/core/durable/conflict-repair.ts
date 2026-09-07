/** A conflict grants bounded file repair under the current owner, never fresh run admission. */
import { Clock, Effect } from 'effect'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import { SourceControlError } from '../../domain/errors.js'
import type { PublicationConflict } from '../../ports/source-control.js'
import type { Writer } from './run-journal.js'

export const reserveConflictRepair = (
  current: DurableWorkflow,
  conflict: PublicationConflict,
  now: number,
): DurableWorkflow => {
  if (
    current.artifact === null ||
    current.repairAttempts >= current.maximumRepairAttempts ||
    now >= current.budgetDeadline
  ) {
    return {
      ...current,
      artifact:
        current.artifact === null
          ? null
          : { ...current.artifact, verifiedRevision: null, publicationConflict: conflict },
      status: {
        _tag: 'Intervention',
        reason: 'Publication conflict repair budget exhausted; conflicted workspace retained',
      },
    }
  }
  return {
    ...current,
    repairAttempts: current.repairAttempts + 1,
    artifact: { ...current.artifact, verifiedRevision: null, publicationConflict: conflict },
    status: {
      _tag: 'Executing',
      deadline: current.budgetDeadline,
      operation: {
        id: `${current.owner ?? current.issueId}:conflict:${current.repairAttempts + 1}`,
        kind: 'repair',
        generation: current.revision + 1,
        attempt: current.repairAttempts + 1,
        inputRevision: conflict.stoppedCommitSha,
        timeoutMs: Math.max(1, current.budgetDeadline - now),
      },
    },
  }
}

export const beginConflictRepair = (
  write: Writer,
  read: Effect.Effect<DurableWorkflow | undefined>,
  issueId: string,
  owner: string,
  conflict: PublicationConflict,
): Effect.Effect<void, SourceControlError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* write(issueId, (current) => reserveConflictRepair(current, conflict, now), owner, true)
    const current = yield* read
    if (
      current?.owner !== owner ||
      current.intent !== 'active' ||
      current.status._tag !== 'Executing' ||
      current.status.operation.kind !== 'repair'
    ) {
      return yield* Effect.fail(
        new SourceControlError({
          category: 'rebase_conflict',
          message:
            'Publication conflict repair was not admitted; inspect the retained workspace and repair budget',
          retryable: false,
          worktreePreserved: true,
        }),
      )
    }
  })
