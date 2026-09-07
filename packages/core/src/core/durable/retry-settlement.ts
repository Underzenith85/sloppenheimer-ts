import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { SourceControlTarget } from '../../ports/source-control.js'

export const retryMatches = (current: DurableWorkflow, target: SourceControlTarget): boolean => {
  const previous = current.runTarget
  return (
    current.status._tag === 'Waiting' &&
    current.status.condition === 'retry' &&
    previous !== undefined &&
    previous._tag === target._tag &&
    previous.branchName === target.branchName &&
    (target._tag === 'Normal' ||
      (previous._tag === 'Repair' && previous.expectedHeadSha === target.expectedHeadSha))
  )
}

/** Only a known pre-agent failure or an inspected workspace still at its baseline permits a fresh attempt. */
export const settleStoppedRun = (
  current: DurableWorkflow,
  observedHeadSha: string | null,
  beforePreparation = false,
): DurableWorkflow => {
  if (current.status._tag !== 'Executing' && current.status._tag !== 'Stopping') {
    return current
  }
  const artifact = current.artifact
  const safe =
    current.runTarget !== undefined &&
    ((beforePreparation && artifact === null) ||
      (observedHeadSha !== null &&
        artifact !== null &&
        observedHeadSha === artifact.baselineSha &&
        artifact.publicationConflict === undefined &&
        artifact.verifiedRevision === null &&
        artifact.publishedHead === null))
  return {
    ...current,
    status: safe
      ? { _tag: 'Waiting', condition: 'retry', deadline: current.budgetDeadline }
      : {
          _tag: 'Intervention',
          reason:
            'Stopped run retained partial or uncertain work; inspect the candidate before resuming',
        },
  }
}
