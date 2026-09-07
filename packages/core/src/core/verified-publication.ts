import { Effect, Option } from 'effect'

import type { Issue } from '../domain/domain.js'
import { SourceControlError } from '../domain/errors.js'
import type {
  VerificationConfig,
  CandidateJournal,
  Candidate,
  CandidateObservation,
  CandidateSourceControlPort,
} from '../ports/candidate.js'
import type {
  PreparedRepository,
  ResolvePublicationConflict,
  PublicationOutcome,
  SourceControlPort,
} from '../ports/source-control.js'

const verificationFailure = (message: string): Effect.Effect<never, SourceControlError> =>
  Effect.fail(
    new SourceControlError({
      category: 'verification_failed',
      message,
      retryable: false,
      worktreePreserved: true,
    }),
  )

/** No hidden mutation after verification: alignment, gate and push are separate port calls. */
export const runVerifiedPublication = (
  sourceControl: SourceControlPort,
  issue: Issue,
  prepared: PreparedRepository,
  verification: VerificationConfig,
  secretEnvironmentNames: readonly string[],
  options: Readonly<{
    resolveConflict?: ResolvePublicationConflict
    journal?: CandidateJournal
    rebaseOnly?: boolean
    beforePublish?: Effect.Effect<void, SourceControlError>
  }> = {},
): Effect.Effect<PublicationOutcome, SourceControlError> =>
  Effect.gen(function* () {
    const rebaseOnly = options.rebaseOnly ?? false
    const candidates = sourceControl.candidates
    if (candidates === undefined) {
      return yield* verificationFailure(
        'source-control adapter does not support exact-candidate verification',
      )
    }
    yield* options.journal?.checkpointing ?? Effect.void
    const checkpoint = yield* candidates.checkpoint(issue, prepared, rebaseOnly)
    if (Option.isNone(checkpoint)) {
      if (rebaseOnly) {
        return yield* verificationFailure(
          'host rebase requires a baseline candidate to verify and settle',
        )
      }
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
        : yield* candidates.align(checkpoint.value, options.resolveConflict)
    return yield* finishPublication(
      candidates,
      aligned,
      checkpoint.value,
      observed,
      verification,
      secretEnvironmentNames,
      options,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlError({
            category: cause.category,
            message: cause.message,
            retryable: cause.retryable,
            worktreePreserved: cause.worktreePreserved,
            retainedCandidate: {
              headSha: aligned.headSha,
              treeSha: aligned.treeSha,
              commitCreated: aligned.commitCreated,
            },
            cause,
          }),
      ),
    )
  })

const finishPublication = (
  candidates: CandidateSourceControlPort,
  aligned: Candidate,
  checkpoint: Candidate,
  observed: CandidateObservation,
  verification: VerificationConfig,
  secretEnvironmentNames: readonly string[],
  options: Readonly<{
    journal?: CandidateJournal
    rebaseOnly?: boolean
    beforePublish?: Effect.Effect<void, SourceControlError>
  }>,
): Effect.Effect<PublicationOutcome, SourceControlError> =>
  Effect.gen(function* () {
    yield* options.journal?.aligned(aligned) ?? Effect.void
    const verified = yield* candidates.verify(aligned, verification, secretEnvironmentNames)
    yield* options.journal?.verified(verified) ?? Effect.void
    if (observed._tag === 'Published' && aligned.headSha === checkpoint.headSha) {
      // A remote fact still needs durable settlement. Reverify because checkpoint/alignment
      // invalidated the previous evidence, then record it without another push.
      const published: PublicationOutcome = {
        _tag: 'Published',
        branchName: aligned.prepared.target.branchName,
        headSha: aligned.headSha,
        commitCreated: aligned.commitCreated,
      }
      yield* options.journal?.published(published) ?? Effect.void
      return options.rebaseOnly === true && aligned.headSha === aligned.prepared.baselineSha
        ? {
            _tag: 'NoChanges',
            branchName: aligned.prepared.target.branchName,
            baselineSha: aligned.prepared.baselineSha,
          }
        : published
    }
    yield* options.beforePublish ?? Effect.void
    const published = yield* candidates.publish(verified)
    yield* options.journal?.published(published) ?? Effect.void
    return published
  })
