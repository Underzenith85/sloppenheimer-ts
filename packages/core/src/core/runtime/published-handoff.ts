import { Effect, Ref } from 'effect'

import type { Issue } from '../../domain/domain.js'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import { TrackerError } from '../../domain/errors.js'
import { issueBranchName } from '../../domain/handoff.js'
import type { CodeReviewPort, HandoffResult } from '../../ports/code-review.js'
import {
  captureExecutionSnapshot,
  issueIsActive,
  issueIsPaused,
  issueIsRoutable,
} from '../policy.js'
import type { EffectiveWorkflow } from '../state.js'
import type { RuntimeCells } from './types.js'

export const owesPublishedHandoff = (record: DurableWorkflow): boolean =>
  record.status._tag === 'Waiting' &&
  record.status.condition === 'review' &&
  record.artifact !== null &&
  record.artifact.publishedHead !== null

const deferredHandoff = (message: string): Effect.Effect<never, TrackerError> =>
  Effect.fail(
    new TrackerError({
      category: 'tracker_request',
      message,
      retryable: true,
    }),
  )

/** Waiting(review) is a durable obligation even if the crash preceded the legacy handoff write. */
export const findOrResumePublishedHandoff = (
  cells: RuntimeCells,
  effective: EffectiveWorkflow,
  capability: CodeReviewPort,
  issue: Issue,
): Effect.Effect<HandoffResult, TrackerError> =>
  Effect.gen(function* () {
    const found = yield* capability.findExistingHandoff(issue)
    if (found._tag !== 'NoBranch' || cells.durable === undefined) {
      return found
    }
    const records = yield* cells.durable.snapshot
    const record = records.find(
      (entry) =>
        entry.issueId === issue.id &&
        entry.identifier === issue.identifier &&
        owesPublishedHandoff(entry),
    )
    if (record === undefined) {
      return found
    }
    const artifact = record.artifact
    if (
      artifact?.repository?.branchName !== issueBranchName(issue) ||
      artifact.publishedHead !== artifact.repository.headSha ||
      artifact.verifiedRevision === null ||
      artifact.verifiedRevision !== artifact.repository.treeSha
    ) {
      return yield* deferredHandoff(
        'Published handoff evidence does not match the current issue branch; reconciliation required',
      )
    }
    const refreshed = (yield* effective.tracker.fetchIssuesByIds([issue.id])).find(
      (entry) => entry.id === issue.id,
    )
    const current = yield* Ref.get(cells.state)
    const latest = (yield* cells.durable.snapshot).find((entry) => entry.issueId === issue.id)
    const execution = captureExecutionSnapshot(effective, '')
    if (
      latest?.revision !== record.revision ||
      latest.intent !== 'active' ||
      refreshed === undefined ||
      refreshed.identifier !== record.identifier ||
      issueIsPaused(current, issue) ||
      !issueIsActive(refreshed, execution) ||
      !issueIsRoutable(refreshed, execution)
    ) {
      return yield* deferredHandoff('Published handoff is waiting for an active, eligible issue')
    }
    // The adapter first finds an existing PR, making a lost create acknowledgement recoverable.
    const handed = yield* capability.handoffCompletedWork(refreshed)
    return handed._tag === 'NoBranch'
      ? yield* deferredHandoff(
          'Confirmed publication has no remote branch; reconciliation required',
        )
      : handed
  })
