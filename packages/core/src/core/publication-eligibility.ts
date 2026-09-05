import { Effect, Ref } from 'effect'

import type { Issue } from '../domain/domain.js'
import { SourceControlError } from '../domain/errors.js'
import type { TrackerPort } from '../ports/tracker.js'
import { issueIsActive, issueIsPaused, issueIsRoutable } from './policy.js'
import type { ExecutionSnapshot, RuntimeState } from './state.js'

/** Recheck after a potentially long gate, immediately before authorizing a remote mutation. */
export const publicationEligibility = (
  state: Ref.Ref<RuntimeState>,
  issue: Issue,
  execution: ExecutionSnapshot,
  tracker: TrackerPort = execution.tracker,
): Effect.Effect<void, SourceControlError> =>
  Effect.gen(function* () {
    const issues = yield* tracker.fetchIssuesByIds([issue.id]).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlError({
            category: 'publication_blocked',
            message: 'publication eligibility could not be refreshed; candidate retained',
            retryable: true,
            worktreePreserved: true,
            cause,
          }),
      ),
    )
    const refreshed = issues.find((candidate) => candidate.id === issue.id)
    const current = yield* Ref.get(state)
    if (
      refreshed === undefined ||
      issueIsPaused(current, issue) ||
      !issueIsActive(refreshed, execution) ||
      !issueIsRoutable(refreshed, execution)
    ) {
      return yield* Effect.fail(
        new SourceControlError({
          category: 'publication_blocked',
          message: 'issue is missing, paused, or no longer eligible; candidate retained',
          retryable: false,
          worktreePreserved: true,
        }),
      )
    }
  })
