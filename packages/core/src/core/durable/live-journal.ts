import { expireWaits } from './deadlines.js'
import { recordCompletions } from './completion-records.js'
import type { Completion } from '../../domain/completion.js'
import { queueCleanup, runCleanup } from './cleanup.js'
import type { WorkspaceManagerPort } from '../../ports/workspace.js'
import type { CapturedWorkspaceMetadata } from '../../domain/workspace-lease.js'
import { externalOperation } from './external-operation.js'
import { recordHandoffs } from './handoff-records.js'
import type { HandoffSnapshot } from '../../domain/handoff.js'
import type { ExternalOperationKind } from '../../domain/durable-workflow.js'
import type { TrackerError } from '../../domain/errors.js'
import { reconcilePublication } from './publication-recovery.js'
import type {
  PreparedRepository,
  SourceControlPort,
  SourceControlRecoveryPort,
} from '../../ports/source-control.js'
import { Clock, Deferred, Effect, Option, Ref } from 'effect'

import type { Issue } from '../../domain/domain.js'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import { WorkflowError, type WorkflowStoreError } from '../../domain/errors.js'
import type { SourceControlTarget } from '../../ports/source-control.js'
import type { WorkflowStorePort } from '../../ports/workflow-store.js'
import { withEntry } from '../../support/collections.js'
import { admission } from './admission.js'
import { restoreWorkflows } from './restore.js'
import { journalFor, type RunJournal, type Writer } from './run-journal.js'
import { transitionWorkflow } from './transition.js'
import { awaitContinuation } from './settlement.js'
import { recordWorkspaces } from './workspace-records.js'

export type { RunJournal } from './run-journal.js'
export type DurableHost = Readonly<{
  journal: (issueId: string) => Effect.Effect<Option.Option<RunJournal>>
  expireWaits: Effect.Effect<void>
  recordCompletions: (completions: readonly Completion[]) => Effect.Effect<void>
  recordWorkspaces: (metadata: readonly CapturedWorkspaceMetadata[]) => Effect.Effect<void>
  queueCleanup: (issueId: string) => Effect.Effect<void>
  continueAfterPublication: (issueId: string) => Effect.Effect<void>
  cleanup: (
    issueId: string,
    workspaces: Pick<WorkspaceManagerPort, 'removeCaptured'>,
  ) => Effect.Effect<void>
  recordHandoffs: (handoffs: readonly HandoffSnapshot[]) => Effect.Effect<void>
  external: <Value>(
    issueId: string,
    kind: ExternalOperationKind,
    headSha: string,
    action: Effect.Effect<Value, TrackerError>,
  ) => Effect.Effect<Value, TrackerError>
  reconcilePublication: (
    issueId: string,
    sourceControl: SourceControlPort | SourceControlRecoveryPort,
    stopped?: Effect.Effect<boolean>,
  ) => Effect.Effect<Option.Option<PreparedRepository>>
  start: (
    issue: Issue,
    target: SourceControlTarget,
    afterPublication?: 'review' | 'continuation',
    verificationRequired?: boolean,
    retryMismatch?: 'reject' | 'intervene',
  ) => Effect.Effect<Option.Option<RunJournal>>
  snapshot: Effect.Effect<readonly DurableWorkflow[]>
  awaitFailure: Effect.Effect<never, WorkflowError>
  setIntent: (identifier: string, intent: DurableWorkflow['intent']) => Effect.Effect<void>
}>

const readJournal = (
  records: Ref.Ref<ReadonlyMap<string, DurableWorkflow>>,
  write: Writer,
  id: string,
): Effect.Effect<Option.Option<RunJournal>> =>
  Effect.map(Ref.get(records), (current) => {
    const record = current.get(id)
    return record?.owner === undefined
      ? Option.none()
      : Option.some(
          journalFor(
            write,
            id,
            record.owner,
            Effect.map(Ref.get(records), (rows) => rows.get(id)),
          ),
        )
  })

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
            const now = yield* Clock.currentTimeMillis
            yield* persist(
              next.revision === current.revision
                ? { ...next, revision: current.revision + 1, updatedAt: now }
                : next,
              current.revision,
            )
          }
        }),
      )
    return {
      journal: (id) => readJournal(records, write, id),
      expireWaits: expireWaits(records, write),
      recordCompletions: (completions) =>
        recordCompletions(records, semaphore, persist, write, completions),
      recordWorkspaces: (metadata) => recordWorkspaces(records, semaphore, persist, metadata),
      queueCleanup: (id) => queueCleanup(write, id),
      continueAfterPublication: (id) => write(id, awaitContinuation),
      cleanup: (id, workspaces) => runCleanup(records, write, id, workspaces),
      recordHandoffs: (handoffs) => recordHandoffs(records, semaphore, persist, write, handoffs),
      external: (id, kind, head, action) =>
        externalOperation(records, write, id, kind, head, action),
      reconcilePublication: (id, sourceControl, stopped) =>
        reconcilePublication(records, write, id, sourceControl, stopped),
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
            const now = yield* Clock.currentTimeMillis
            yield* write(record.issueId, (current) =>
              transitionWorkflow(current, { _tag: 'IntentChanged', intent }, now),
            )
          }
        }),
      start: admission(records, semaphore, persist, write),
    }
  })
