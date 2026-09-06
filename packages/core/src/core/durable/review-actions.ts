import { Effect, Option, Ref } from 'effect'

import type { Issue } from '../../domain/domain.js'
import type { ExternalOperationKind } from '../../domain/durable-workflow.js'
import { TrackerError } from '../../domain/errors.js'
import { issueIsActive, issueIsPaused, issueIsRoutable } from '../policy.js'
import type { ExecutionSnapshot } from '../state.js'
import type { OrchestratorContext } from '../runtime/types.js'

/** Eligibility is refreshed adjacent to every write; observing a remote fact grants no new intent. */
export const reviewAction = <Value>(
  context: Pick<OrchestratorContext, 'state' | 'durable'>,
  issue: Issue,
  execution: ExecutionSnapshot,
  kind: ExternalOperationKind,
  headSha: string,
  action: Effect.Effect<Value, TrackerError>,
): Effect.Effect<Value, TrackerError> =>
  Effect.gen(function* () {
    const refreshed = (yield* execution.tracker.fetchIssuesByIds([issue.id])).find(
      (candidate) => candidate.id === issue.id,
    )
    const state = yield* Ref.get(context.state)
    if (
      refreshed === undefined ||
      issueIsPaused(state, issue) ||
      !issueIsActive(refreshed, execution) ||
      !issueIsRoutable(refreshed, execution)
    ) {
      return yield* Effect.fail(
        new TrackerError({
          category: 'tracker_status',
          message: 'External action held: the issue is paused, missing, or no longer eligible',
          retryable: false,
        }),
      )
    }
    if (context.durable === undefined) {
      return yield* action
    }
    const record = (yield* context.durable.snapshot).find((value) => value.issueId === issue.id)
    const identity = record?.artifact?.repository?.identity
    if (
      identity !== undefined &&
      identity !== execution.sourceControl?.recovery?.repositoryIdentity
    ) {
      return yield* Effect.fail(
        new TrackerError({
          category: 'tracker_status',
          message: 'Recorded publication belongs to a different repository',
          retryable: false,
        }),
      )
    }
    if (kind === 'ensure_pull_request' && Option.isNone(execution.codeReview)) {
      return yield* Effect.fail(
        new TrackerError({
          category: 'tracker_status',
          message: 'Code review capability is unavailable',
          retryable: false,
        }),
      )
    }
    return yield* context.durable.external(issue.id, kind, headSha, action)
  })
