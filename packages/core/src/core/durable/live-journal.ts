import { reconcilePublication } from './publication-recovery.js'
import type { SourceControlRecoveryPort } from '../../ports/source-control.js'
import { Clock, Deferred, Effect, Option, Ref } from 'effect'

import type { Issue } from '../../domain/domain.js'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import { WorkflowError, type WorkflowStoreError } from '../../domain/errors.js'
import type { SourceControlTarget } from '../../ports/source-control.js'
import type { WorkflowStorePort } from '../../ports/workflow-store.js'
import { withEntry } from '../../support/collections.js'
import { admission } from './admission.js'
import { restoreWorkflows } from './restore.js'
import type { RunJournal, Writer } from './run-journal.js'

export type { RunJournal } from './run-journal.js'
export type DurableHost = Readonly<{
  reconcilePublication: (
    issueId: string,
    recovery: SourceControlRecoveryPort,
  ) => Effect.Effect<void>
  start: (
    issue: Issue,
    target: SourceControlTarget,
    afterPublication?: 'review' | 'continuation',
  ) => Effect.Effect<Option.Option<RunJournal>>
  snapshot: Effect.Effect<readonly DurableWorkflow[]>
  awaitFailure: Effect.Effect<never, WorkflowError>
  setIntent: (identifier: string, intent: DurableWorkflow['intent']) => Effect.Effect<void>
}>

/** Store failures are delivered to the host supervisor, then interrupt the mutation that failed. */
export const makeDurableHost = (
  store: WorkflowStorePort,
): Effect.Effect<DurableHost, WorkflowError> =>
  Effect.gen(function* () {
    const restored = yield* restoreWorkflows(store).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowError({
            category: 'invalid_config',
            message: 'durable workflow store could not be opened',
            cause,
          }),
      ),
    )
    const records = yield* Ref.make<ReadonlyMap<string, DurableWorkflow>>(
      new Map(restored.map((record) => [record.issueId, record])),
    )
    const failure = yield* Deferred.make<WorkflowStoreError>()
    const semaphore = yield* Effect.makeSemaphore(1)
    const guarded = <Value>(body: Effect.Effect<Value, WorkflowStoreError>): Effect.Effect<Value> =>
      body.pipe(
        Effect.catchAll((error) =>
          Deferred.succeed(failure, error).pipe(Effect.zipRight(Effect.interrupt)),
        ),
      )
    const persist = (next: DurableWorkflow, expected: number | null): Effect.Effect<void> =>
      Effect.uninterruptible(
        guarded(store.commit(next, expected)).pipe(
          Effect.zipRight(Ref.update(records, (current) => withEntry(current, next.issueId, next))),
        ),
      )
    const write: Writer = (issueId, update, owner, requireActive) =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = (yield* Ref.get(records)).get(issueId)
          if (current === undefined) {
            return
          }
          if (
            (owner !== undefined && current.owner !== owner) ||
            (requireActive === true && current.intent !== 'active')
          ) {
            return yield* Effect.interrupt
          }
          const next = update(current)
          if (next !== current) {
            yield* persist(
              {
                ...next,
                revision: current.revision + 1,
                updatedAt: yield* Clock.currentTimeMillis,
              },
              current.revision,
            )
          }
        }),
      )
    return {
      reconcilePublication: (id, recovery) => reconcilePublication(records, write, id, recovery),
      snapshot: Effect.map(Ref.get(records), (current) => [...current.values()]),
      awaitFailure: Deferred.await(failure).pipe(
        Effect.flatMap((cause) =>
          Effect.fail(
            new WorkflowError({
              category: 'invalid_config',
              message: 'durable persistence failed; host stopped before further dispatch',
              cause,
            }),
          ),
        ),
      ),
      setIntent: (identifier, intent) =>
        Effect.gen(function* () {
          const record = [...(yield* Ref.get(records)).values()].find(
            (entry) => entry.identifier === identifier,
          )
          if (record !== undefined) {
            yield* write(record.issueId, (current) => ({ ...current, intent }))
          }
        }),
      start: admission(records, semaphore, persist, write),
    }
  })
