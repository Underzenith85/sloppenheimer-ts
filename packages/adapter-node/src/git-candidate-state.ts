import { Effect } from 'effect'
import { SourceControlError } from '@sloppenheimer/core/domain/errors.js'
import type { Candidate } from '@sloppenheimer/core/ports/candidate.js'
import { revParse, status } from './git-queries.js'
import type { GitSourceControlSettings } from './git-process.js'

export const candidateFailure = (
  category: 'candidate_changed' | 'verification_failed',
  message: string,
  cause?: unknown,
): SourceControlError =>
  new SourceControlError({
    category,
    message,
    retryable: false,
    worktreePreserved: true,
    cause,
  })

export const assertCandidate = (
  settings: GitSourceControlSettings,
  candidate: Candidate,
): Effect.Effect<void, SourceControlError> =>
  Effect.gen(function* () {
    const workspace = candidate.prepared.workspace
    const head = yield* revParse(settings, 'publish', workspace, 'HEAD')
    const tree = yield* revParse(settings, 'publish', workspace, 'HEAD^{tree}')
    const dirty = yield* status(settings, 'publish', workspace)
    if (head !== candidate.headSha || tree !== candidate.treeSha || dirty.length !== 0) {
      return yield* Effect.fail(
        candidateFailure(
          'candidate_changed',
          'candidate changed after checkpoint; inspection and verification must run again',
        ),
      )
    }
  })
