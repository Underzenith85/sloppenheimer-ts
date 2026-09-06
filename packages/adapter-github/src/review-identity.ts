import { Effect, Schema } from 'effect'

import type { CodexReviewObservation } from '@sloppenheimer/core/domain/handoff.js'
import type { TrackerError } from '@sloppenheimer/core/domain/errors.js'
import { githubJson } from './client.js'
import type { GitHubProviderConfig } from './provider.js'

/** GitHub resolves abbreviated identities; a matching prefix alone never proves review coverage. */
export const resolveReviewedCommit = (
  provider: GitHubProviderConfig,
  prefix: string,
  review: Readonly<{ headShaPrefix: string; status: CodexReviewObservation['status'] }>,
): Effect.Effect<CodexReviewObservation | null, TrackerError> =>
  Effect.gen(function* () {
    const response = yield* githubJson(
      provider,
      `${prefix}/commits/${encodeURIComponent(review.headShaPrefix)}`,
    )
    const decoded = Schema.decodeUnknownOption(
      Schema.Struct({ sha: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40}$/u)) }),
    )(response.body)
    if (decoded._tag === 'None' || !decoded.value.sha.startsWith(review.headShaPrefix)) {
      return null
    }
    return { headSha: decoded.value.sha, status: review.status }
  })
