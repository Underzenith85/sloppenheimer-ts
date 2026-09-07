import { Clock, Effect, Option, Ref } from 'effect'
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
      artifact.verifiedRevision === null ||
      artifact.verifiedRevision !== repository.treeSha
    ) {
      return Option.none()
    }
    const observed = yield* Effect.either(recovery.observeHead(repository.branchName))
    const stopped = yield* confirmStopped
    const now = yield* Clock.currentTimeMillis
    let resumable = Option.none<PreparedRepository>()
    if (
      observed._tag === 'Right' &&
      stopped &&
      canInspect(sourceControl) &&
      !Option.contains(observed.right, repository.headSha)
    ) {
      const prepared: PreparedRepository = {
        workspace: { path: artifact.workspacePath, key: artifact.workspaceKey },
        target: record.runTarget ?? { _tag: 'Normal', branchName: repository.branchName },
        baseBranch: repository.baseBranch,
        baseSha: repository.baseSha,
        baselineSha: artifact.baselineSha,
        retainedCandidate: {
          headSha: repository.headSha,
          treeSha: artifact.verifiedRevision,
          commitCreated: false,
        },
        expectedRemoteHead: Option.fromNullable(artifact.expectedRemoteHead),
        ...(repository.identity === undefined ? {} : { repositoryIdentity: repository.identity }),
      }
      const inspected = yield* Effect.either(sourceControl.inspect(prepared))
      if (inspected._tag === 'Right' && inspected.right._tag === 'Changed') {
        resumable = Option.some(prepared)
      }
    }
    yield* write(issueId, (current) => {
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
      const published = Option.contains(observed.right, repository.headSha)
      return {
        ...current,
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
            : {
                _tag: 'Intervention',
                reason: Option.isSome(resumable)
                  ? 'Previous processes stopped and retained candidate inspection found unpublished work.'
                  : published
                    ? 'The verified candidate is published. Confirm the previous command stopped before resuming review or reusing its workspace.'
                    : 'The remote does not match the verified candidate. Retain the workspace and reconcile before another publication.',
              },
      }
    })
    return resumable
  })
