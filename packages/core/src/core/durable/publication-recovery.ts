/**
 * Reconciliation of a workflow held in intervention with unpublished work still on disk.
 *
 * It records remote facts without granting ownership of the old workspace or authorizing another
 * write, and — where the observations are safe — admits one freshly bounded recovery attempt over
 * the retained candidate. Legacy records whose verification evidence was invalidated or never
 * written are recoverable here: what they no longer prove is re-established by inspection and by
 * the recovery's own checkpoint, never assumed from the diagnostic they were left with.
 */
import { Clock, Effect, Either, Option, Ref } from 'effect'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type {
  PreparedRepository,
  SourceControlPort,
  SourceControlRecoveryPort,
} from '../../ports/source-control.js'
import {
  assessRetainedCandidate,
  provenTree,
  refused,
  type RetainedAssessment,
  type RetainedInspection,
} from './retained-candidate.js'
import type { Writer } from './run-journal.js'

const recoveryOf = (
  sourceControl: SourceControlPort | SourceControlRecoveryPort,
): SourceControlRecoveryPort | undefined =>
  'observeHead' in sourceControl ? sourceControl : sourceControl.recovery

const canInspect = (
  sourceControl: SourceControlPort | SourceControlRecoveryPort,
): sourceControl is SourceControlPort => 'inspect' in sourceControl

const migrationRepairAttempts = 3
const migrationBudgetMs = 86_400_000

type RemoteObservation = Either.Either<Option.Option<string>, unknown>

type ObservedRecord = Omit<RetainedInspection, 'observedHead' | 'observedBaseSha'>

/**
 * Nothing is inspected until the previous process is proven stopped and both remote facts are in
 * hand, so each refusal names which prerequisite the retained candidate failed rather than
 * answering with an absence.
 */
const assessRetained = (
  sourceControl: SourceControlPort | SourceControlRecoveryPort,
  observedRecord: ObservedRecord,
  observed: RemoteObservation,
  observedBase: RemoteObservation,
  stopped: boolean,
): Effect.Effect<RetainedAssessment> => {
  if (
    observed._tag === 'Left' ||
    observedBase._tag === 'Left' ||
    Option.isNone(observedBase.right)
  ) {
    return Effect.succeed(
      refused('Remote observation was incomplete; no recovery mutation was admitted.'),
    )
  }
  if (Option.contains(observed.right, observedRecord.repository.headSha)) {
    return Effect.succeed(
      refused('The recorded candidate head is already on the remote; nothing was admitted.'),
    )
  }
  if (!stopped) {
    return Effect.succeed(
      refused(
        'Previous workspace process is not confirmed stopped; no recovery mutation was admitted.',
      ),
    )
  }
  if (!canInspect(sourceControl)) {
    return Effect.succeed(
      refused(
        'The composed source control cannot inspect a retained workspace; no recovery mutation was admitted.',
      ),
    )
  }
  return assessRetainedCandidate(sourceControl, {
    ...observedRecord,
    observedHead: observed.right,
    observedBaseSha: observedBase.right.value,
  })
}

const reconciledRecord = (
  current: DurableWorkflow,
  record: DurableWorkflow,
  observed: RemoteObservation,
  observedBase: RemoteObservation,
  stopped: boolean,
  assessment: RetainedAssessment,
  now: number,
): DurableWorkflow => {
  if (current.revision !== record.revision) {
    return current
  }
  if (observed._tag === 'Left') {
    return {
      ...current,
      status: {
        _tag: 'Intervention',
        reason: 'Remote publication could not be observed; candidate retained for recovery.',
      },
    }
  }
  if (observedBase._tag === 'Left' || Option.isNone(observedBase.right)) {
    return {
      ...current,
      status: {
        _tag: 'Intervention',
        reason: 'Protected base could not be observed; no legacy recovery mutation was admitted.',
      },
    }
  }
  const artifact = record.artifact
  const repository = artifact?.repository
  if (artifact === null || artifact === undefined || repository === undefined) {
    return current
  }
  const published = Option.contains(observed.right, repository.headSha)
  // Null or superseded evidence is never current verification, so a head that reached the remote
  // without it still owes this workflow verification before a review can be waited on.
  const verified = !record.verificationRequired || provenTree(artifact, repository) !== null
  // One structured recovery per record: the marker is what keeps a repeated operator retry from
  // buying another repair budget for work the first migration already bounded.
  const migrated = assessment._tag === 'Resumable' && record.publicationRecovery === undefined
  const reason =
    assessment._tag === 'Resumable'
      ? migrated
        ? 'Legacy publication conflict reconciled from fresh candidate, base, and remote-head observations.'
        : 'Previous processes stopped and retained candidate inspection found unpublished work.'
      : published && verified
        ? 'The verified candidate is published. Confirm the previous command stopped before resuming review or reusing its workspace.'
        : published
          ? 'The recorded candidate head is published without current verification evidence; reconcile before resuming review.'
          : assessment.reason
  return {
    ...current,
    ...(migrated
      ? {
          publicationRecovery: {
            kind: 'legacy_publication_conflict' as const,
            admittedAt: now,
            maximumRepairAttempts: migrationRepairAttempts,
          },
          repairAttempts: 0,
          maximumRepairAttempts: migrationRepairAttempts,
          budgetDeadline: now + migrationBudgetMs,
        }
      : {}),
    artifact: {
      ...artifact,
      remoteObservation: { headSha: Option.getOrNull(observed.right), observedAt: now },
      publishedHead: published ? repository.headSha : artifact.publishedHead,
    },
    status:
      published && stopped && verified
        ? {
            _tag: 'Waiting',
            condition: current.afterPublication ?? 'review',
            deadline: current.budgetDeadline,
          }
        : { _tag: 'Intervention', reason },
  }
}

/** Record remote facts without granting ownership of the old workspace or authorizing another write. */
export const reconcilePublication = (
  records: Ref.Ref<ReadonlyMap<string, DurableWorkflow>>,
  write: Writer,
  issueId: string,
  sourceControl: SourceControlPort | SourceControlRecoveryPort,
  confirmStopped: Effect.Effect<boolean> = Effect.succeed(false),
): Effect.Effect<Option.Option<PreparedRepository>> =>
  Effect.gen(function* () {
    const recovery = recoveryOf(sourceControl)
    const record = (yield* Ref.get(records)).get(issueId)
    const artifact = record?.artifact
    const repository = artifact?.repository
    if (
      record === undefined ||
      record.status._tag !== 'Intervention' ||
      artifact === null ||
      artifact === undefined ||
      repository === undefined ||
      recovery === undefined ||
      repository.identity !== recovery.repositoryIdentity
    ) {
      return Option.none()
    }
    // These are independent remote facts. In particular, never reconstruct either one from the
    // diagnostic or from refs in the retained checkout.
    const [observed, observedBase] = yield* Effect.all(
      [
        Effect.either(recovery.observeHead(repository.branchName)),
        canInspect(sourceControl)
          ? Effect.either(recovery.observeHead(repository.baseBranch))
          : Effect.succeed(Either.right(Option.some(repository.baseSha))),
      ],
      { concurrency: 2 },
    )
    const stopped = yield* confirmStopped
    const assessment = yield* assessRetained(
      sourceControl,
      { record, artifact, repository },
      observed,
      observedBase,
      stopped,
    )
    const now = yield* Clock.currentTimeMillis
    yield* write(issueId, (current) =>
      reconciledRecord(current, record, observed, observedBase, stopped, assessment, now),
    )
    return assessment._tag === 'Resumable' ? Option.some(assessment.prepared) : Option.none()
  })

/**
 * Records why a recovery was refused after the reconciliation itself had already answered, so a
 * supervision or scheduling failure reaches the operator as a reason rather than as silence.
 *
 * Only an intervention is rewritten: a record that has since moved on is never dragged back.
 */
export const holdRecovery = (write: Writer, issueId: string, reason: string): Effect.Effect<void> =>
  write(issueId, (current) =>
    current.status._tag !== 'Intervention' || current.status.reason === reason
      ? current
      : { ...current, status: { _tag: 'Intervention', reason } },
  )
