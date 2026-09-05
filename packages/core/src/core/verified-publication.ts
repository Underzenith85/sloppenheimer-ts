import { Effect, Option } from 'effect'

import type { Issue } from '../domain/domain.js'
import { SourceControlError } from '../domain/errors.js'
import type { VerificationConfig, CandidateJournal } from '../ports/candidate.js'
import type {
  PreparedRepository,
  PublicationOutcome,
  SourceControlPort,
} from '../ports/source-control.js'

/** No hidden mutation after verification: alignment, gate and push are separate port calls. */
export const runVerifiedPublication = (
  sourceControl: SourceControlPort,
  issue: Issue,
  prepared: PreparedRepository,
  verification: VerificationConfig,
  secretEnvironmentNames: readonly string[],
  options: Readonly<{
    journal?: CandidateJournal
    rebaseOnly?: boolean
    beforePublish?: Effect.Effect<void, SourceControlError>
  }> = {},
): Effect.Effect<PublicationOutcome, SourceControlError> =>
  Effect.gen(function* () {
    const rebaseOnly = options.rebaseOnly ?? false
    const candidates = sourceControl.candidates
    if (candidates === undefined) {
      return yield* Effect.fail(
        new SourceControlError({
          category: 'verification_failed',
          message: 'source-control adapter does not support exact-candidate verification',
          retryable: false,
          worktreePreserved: true,
        }),
      )
    }
    yield* options.journal?.checkpointing ?? Effect.void
    const checkpoint = yield* candidates.checkpoint(issue, prepared, rebaseOnly)
    if (Option.isNone(checkpoint)) {
      return {
        _tag: 'NoChanges',
        branchName: prepared.target.branchName,
        baselineSha: prepared.baselineSha,
      }
    }
    yield* options.journal?.checkpointed(checkpoint.value) ?? Effect.void
    const observed = yield* candidates.observe(checkpoint.value)
    if (observed._tag === 'Diverged') {
      return yield* Effect.fail(
        new SourceControlError({
          category: 'lease_conflict',
          message: 'candidate remote head changed; work is retained for reconciliation',
          retryable: false,
          worktreePreserved: true,
        }),
      )
    }
    // An acknowledged remote fact must be checked before any rebase can rewrite its local identity.
    const aligned =
      observed._tag === 'Published' && !rebaseOnly
        ? checkpoint.value
        : yield* candidates.align(checkpoint.value)
    if (rebaseOnly && aligned.headSha === checkpoint.value.headSha) {
      return {
        _tag: 'NoChanges',
        branchName: prepared.target.branchName,
        baselineSha: prepared.baselineSha,
      }
    }
    yield* options.journal?.aligned(aligned) ?? Effect.void
    const verified = yield* candidates.verify(aligned, verification, secretEnvironmentNames)
    yield* options.journal?.verified(verified) ?? Effect.void
    yield* options.beforePublish ?? Effect.void
    const published = yield* candidates.publish(verified)
    yield* options.journal?.published(published) ?? Effect.void
    return published
  })
