import { Clock, Effect, Either, Option, Ref } from 'effect'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type {
  PreparedRepository,
  SourceControlPort,
  SourceControlRecoveryPort,
} from '../../ports/source-control.js'
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

const reconciledRecord = (
  current: DurableWorkflow,
  record: DurableWorkflow,
  observed: RemoteObservation,
  observedBase: RemoteObservation,
  stopped: boolean,
  resumable: Option.Option<PreparedRepository>,
  refusal: string | null,
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
  const migrated = Option.isSome(resumable) && artifact.publicationConflict === undefined
  const reason = Option.isSome(resumable)
    ? migrated
      ? 'Legacy publication conflict reconciled from fresh candidate, base, and remote-head observations.'
      : 'Previous processes stopped and retained candidate inspection found unpublished work.'
    : published
      ? 'The verified candidate is published. Confirm the previous command stopped before resuming review or reusing its workspace.'
      : stopped
        ? (refusal ??
          'Retained candidate inspection found no unpublished candidate; no recovery mutation was admitted.')
        : 'Previous workspace process is not confirmed stopped; no recovery mutation was admitted.'
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
      published && stopped
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
      repository.identity !== recovery.repositoryIdentity ||
      (artifact.verifiedRevision !== null && artifact.verifiedRevision !== repository.treeSha)
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
    const now = yield* Clock.currentTimeMillis
    let resumable = Option.none<PreparedRepository>()
    let refusal: string | null = null
    if (
      observed._tag === 'Right' &&
      observedBase._tag === 'Right' &&
      Option.isSome(observedBase.right) &&
      stopped &&
      canInspect(sourceControl) &&
      !Option.contains(observed.right, repository.headSha)
    ) {
      const inspectionPreparation: PreparedRepository = {
        workspace: { path: artifact.workspacePath, key: artifact.workspaceKey },
        target: record.runTarget ?? { _tag: 'Normal', branchName: repository.branchName },
        baseBranch: repository.baseBranch,
        baseSha: observedBase.right.value,
        baselineSha: artifact.baselineSha,
        // The fresh recovery owns the exact head it just observed, not the lease the legacy
        // publication captured before the host stopped.
        expectedRemoteHead: observed.right,
        ...(repository.identity === undefined ? {} : { repositoryIdentity: repository.identity }),
      }
      const inspected = yield* Effect.either(sourceControl.inspect(inspectionPreparation))
      if (inspected._tag === 'Left') {
        refusal = `Retained candidate inspection failed: ${inspected.left.message}`
      } else if (inspected.right._tag !== 'Changed') {
        refusal = 'Retained workspace contains no unpublished candidate.'
      } else if (inspected.right.dirtyFileCount !== 0) {
        refusal = 'Retained workspace is dirty; candidate identity cannot be established safely.'
      } else if (!inspected.right.committedAhead) {
        refusal = 'Retained workspace head is not ahead of the recorded remote baseline.'
      } else if (inspected.right.headSha !== repository.headSha) {
        refusal = 'Retained workspace head does not match the recorded candidate head.'
      } else if (inspected.right.descendsFromBaseline !== true) {
        refusal = 'Retained candidate does not descend from its recorded baseline.'
      } else if (inspected.right.treeSha === undefined) {
        refusal = 'Retained candidate tree identity could not be established.'
      } else {
        resumable = Option.some({
          ...inspectionPreparation,
          retainedCandidate: {
            headSha: inspected.right.headSha,
            treeSha: inspected.right.treeSha,
            commitCreated: false,
          },
        })
      }
    }
    yield* write(issueId, (current) =>
      reconciledRecord(current, record, observed, observedBase, stopped, resumable, refusal, now),
    )
    return resumable
  })
