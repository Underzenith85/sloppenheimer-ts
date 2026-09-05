import type { CandidateJournal } from '../ports/candidate.js'
import { Effect, Option } from 'effect'

import type { Issue } from '../domain/domain.js'
import type { AgentError, WorkspaceError } from '../domain/errors.js'
import type { PreparedRepository, SourceControlPort } from '../ports/source-control.js'
import { asSettled } from '../support/settled.js'
import type { PostflightOutcome } from './postflight.js'

export type RunResult = Readonly<{
  outcome: 'normal' | 'failed'
  error: string | null
  postflight: PostflightOutcome
}>

/** Preserve useful partial work after a failed session; this does not authorize publication. */
export const retainFailedCandidate = (
  sourceControl: SourceControlPort,
  issue: Issue,
  prepared: PreparedRepository,
  failure: AgentError | WorkspaceError,
  journal?: CandidateJournal,
): Effect.Effect<RunResult, AgentError | WorkspaceError> =>
  Effect.gen(function* () {
    yield* journal?.checkpointing ?? Effect.void
    const inspected = yield* sourceControl.inspect(prepared).pipe(asSettled)
    if (inspected._tag === 'Succeeded' && inspected.value._tag === 'Clean') {
      return yield* Effect.fail(failure)
    }
    const candidates = sourceControl.candidates
    const checkpoint =
      candidates === undefined || inspected._tag === 'Failed'
        ? null
        : yield* candidates.checkpoint(issue, prepared).pipe(asSettled)
    if (checkpoint !== null && checkpoint._tag === 'Succeeded' && Option.isSome(checkpoint.value)) {
      yield* journal?.checkpointed(checkpoint.value.value) ?? Effect.void
    }
    // A failed inspection or checkpoint means unknown work, not proof that no work exists.
    const checkpointed =
      checkpoint !== null && checkpoint._tag === 'Succeeded' && Option.isSome(checkpoint.value)
    return {
      outcome: 'failed',
      error: failure.message,
      postflight: {
        _tag: 'DeliveryFailed',
        branchName: prepared.target.branchName,
        changedFileCount:
          inspected._tag === 'Succeeded' && inspected.value._tag === 'Changed'
            ? inspected.value.dirtyFileCount
            : null,
        prepared,
        failure: {
          category: 'candidate_partial',
          message: checkpointed
            ? 'agent execution failed; partial candidate checkpointed for inspection'
            : 'agent execution failed; workspace retained and candidate state requires inspection',
          retryable: false,
          worktreePreserved: true,
        },
      },
    }
  })
