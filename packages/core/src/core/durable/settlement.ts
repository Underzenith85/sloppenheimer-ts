import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { PublicationOutcome } from '../../ports/source-control.js'
import type { PostflightOutcome } from '../postflight.js'

/** Preserve observed remote facts; only an exactly verified publication earns review admission. */
export const settleRun = (
  current: DurableWorkflow,
  outcome: PostflightOutcome | PublicationOutcome,
): DurableWorkflow => {
  const artifact = current.artifact
  const verified =
    outcome._tag === 'Published' &&
    artifact !== null &&
    (!current.verificationRequired ||
      (artifact.repository?.headSha === outcome.headSha &&
        artifact.verifiedRevision !== null &&
        artifact.verifiedRevision === artifact.repository.treeSha))
  const publishedArtifact =
    outcome._tag === 'Published' && artifact !== null
      ? {
          ...artifact,
          publishedHead: outcome.headSha,
          ...(!current.verificationRequired && artifact.repository !== undefined
            ? { repository: { ...artifact.repository, headSha: outcome.headSha } }
            : {}),
        }
      : artifact
  return {
    ...current,
    artifact: publishedArtifact,
    status:
      verified || (outcome._tag === 'NoChanges' && current.afterPublication === 'continuation')
        ? {
            _tag: 'Waiting',
            condition: current.afterPublication ?? 'review',
            deadline: current.budgetDeadline,
          }
        : {
            _tag: 'Intervention',
            reason:
              outcome._tag === 'Published'
                ? 'Observed publication does not match durable verification evidence; inspect before repair'
                : outcome._tag === 'DeliveryFailed'
                  ? 'Candidate retained: ' + outcome.failure.message
                  : 'Run ended without a published candidate; inspect before a new coding attempt',
          },
  }
}

/** A confirmed missing pull request turns the published run into an ordinary continuation wait. */
export const awaitContinuation = (current: DurableWorkflow): DurableWorkflow =>
  current.status._tag === 'Waiting' && current.status.condition === 'review'
    ? {
        ...current,
        afterPublication: 'continuation',
        status: { ...current.status, condition: 'continuation' },
      }
    : current
