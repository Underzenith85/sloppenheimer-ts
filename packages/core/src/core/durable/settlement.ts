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
    artifact.repository?.headSha === outcome.headSha &&
    artifact.verifiedRevision !== null &&
    artifact.verifiedRevision === artifact.repository.treeSha
  return {
    ...current,
    artifact:
      outcome._tag === 'Published' && artifact !== null
        ? { ...artifact, publishedHead: outcome.headSha }
        : artifact,
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
