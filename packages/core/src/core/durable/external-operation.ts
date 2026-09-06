import { Cause, Clock, Effect, Exit, Ref } from 'effect'

import type { DurableWorkflow, ExternalOperationKind } from '../../domain/durable-workflow.js'
import { TrackerError } from '../../domain/errors.js'
import type { Writer } from './run-journal.js'

const refused = (message: string): TrackerError =>
  new TrackerError({ category: 'tracker_status', message, retryable: false })

/** Persist write intent and its exact head before calling the adapter, then preserve every exit. */
export const externalOperation = <Value>(
  records: Ref.Ref<ReadonlyMap<string, DurableWorkflow>>,
  write: Writer,
  issueId: string,
  kind: ExternalOperationKind,
  headSha: string,
  action: Effect.Effect<Value, TrackerError>,
): Effect.Effect<Value, TrackerError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const before = (yield* Ref.get(records)).get(issueId)
      const now = yield* Clock.currentTimeMillis
      if (before === undefined || before.intent !== 'active' || now >= before.budgetDeadline) {
        return yield* Effect.fail(
          refused('Workflow intent or deadline prevents the external action'),
        )
      }
      if (before.externalOperation?.outcome === 'pending') {
        return yield* Effect.fail(refused('Another external operation owns this workflow'))
      }
      if (
        kind === 'ensure_pull_request' &&
        (before.artifact?.publishedHead !== headSha ||
          before.artifact.verifiedRevision === null ||
          before.artifact.verifiedRevision !== before.artifact.repository?.treeSha)
      ) {
        return yield* Effect.fail(refused('PR creation requires the exact verified publication'))
      }
      if (before.status._tag === 'Intervention') {
        return yield* Effect.fail(refused(before.status.reason))
      }
      if (before.artifact !== null && before.artifact.publishedHead !== headSha) {
        return yield* Effect.fail(
          refused('Current head has no matching durable publication evidence'),
        )
      }
      const sameInput = before.externalOperation?.id === `${issueId}:${kind}:${headSha}`
      if (sameInput && before.repeatedFailures >= 3) {
        yield* write(issueId, (current) => ({
          ...current,
          status: {
            _tag: 'Intervention',
            reason:
              'External action retry budget exhausted; inspect the exact head and remote outcome before continuing',
          },
        }))
        return yield* Effect.fail(
          refused('External action retry budget exhausted; intervention required'),
        )
      }
      const generation = before.revision + 1
      const operation = {
        id: `${issueId}:${kind}:${headSha}`,
        kind,
        headSha,
        generation,
        deadline: Math.min(before.budgetDeadline, now + 60_000),
        outcome: 'pending' as const,
      }
      yield* write(issueId, (current) =>
        current.revision === before.revision
          ? { ...current, externalOperation: operation }
          : current,
      )
      const claimed = (yield* Ref.get(records)).get(issueId)
      if (claimed?.externalOperation !== operation || claimed.intent !== 'active') {
        return yield* Effect.fail(refused('External action was superseded before launch'))
      }
      const exit = yield* Effect.exit(
        restore(action).pipe(
          Effect.timeoutFail({
            duration: Math.max(1, operation.deadline - (yield* Clock.currentTimeMillis)),
            onTimeout: () =>
              refused('External action deadline expired; reconcile before repeating'),
          }),
        ),
      )
      const settledAt = yield* Clock.currentTimeMillis
      yield* write(issueId, (current) => {
        if (current.externalOperation?.generation !== generation) {
          return current
        }
        return {
          ...current,
          lastProgressAt: Exit.isSuccess(exit) ? settledAt : current.lastProgressAt,
          repeatedFailures: Exit.isSuccess(exit) ? 0 : sameInput ? current.repeatedFailures + 1 : 1,
          lastFailureSignature: Exit.isSuccess(exit) ? null : operation.id,
          externalOperation: {
            ...operation,
            outcome: Exit.isSuccess(exit)
              ? 'succeeded'
              : Cause.isInterrupted(exit.cause) || Cause.isDie(exit.cause)
                ? 'unknown'
                : 'failed',
          },
        }
      })
      return yield* exit
    }),
  )
