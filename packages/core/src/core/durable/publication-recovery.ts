import { Clock, Effect, Option, Ref } from 'effect'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { SourceControlRecoveryPort } from '../../ports/source-control.js'
import type { Writer } from './run-journal.js'

/** Record remote facts without granting ownership of the old workspace or authorizing another write. */
export const reconcilePublication = (
  records: Ref.Ref<ReadonlyMap<string, DurableWorkflow>>,
  write: Writer,
  issueId: string,
  recovery: SourceControlRecoveryPort,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const record = (yield* Ref.get(records)).get(issueId)
    const artifact = record?.artifact
    const repository = artifact?.repository
    if (
      record === undefined ||
      record.status._tag !== 'Intervention' ||
      artifact === null ||
      artifact === undefined ||
      repository === undefined ||
      repository.identity !== recovery.repositoryIdentity ||
      artifact.verifiedRevision === null ||
      artifact.verifiedRevision !== repository.treeSha
    ) {
      return
    }
    const observed = yield* Effect.either(recovery.observeHead(repository.branchName))
    const now = yield* Clock.currentTimeMillis
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
        status: {
          _tag: 'Intervention',
          reason: published
            ? 'The verified candidate is published. Confirm the previous command stopped before resuming review or reusing its workspace.'
            : 'The remote does not match the verified candidate. Retain the workspace and reconcile before another publication.',
        },
      }
    })
  })
