import { Effect, Schema } from 'effect'
import type { TrackerError } from '@sloppenheimer/core/domain/errors.js'
import {
  githubJson,
  githubMaxPages,
  githubPageSize,
  parseNextUrl,
  trackerCause,
  trackerPaginationError,
} from './client.js'
import type { GitHubProviderConfig } from './provider.js'
import { decode } from './pull-request-payloads.js'

export const reviewRequestBody = (headSha: string): string =>
  `@codex review\n\n<!-- sloppenheimer:review:${headSha} -->`

/** Reconcile a lost comment acknowledgement before repeating the request for this exact head. */
export const reviewRequestExists = (
  provider: GitHubProviderConfig,
  prefix: string,
  number: number,
  headSha: string,
): Effect.Effect<boolean, TrackerError> =>
  Effect.gen(function* () {
    let next: string | null =
      `${prefix}/issues/${String(number)}/comments?per_page=${String(githubPageSize)}`
    let pages = 0
    while (next !== null) {
      if (pages >= githubMaxPages) {
        return yield* Effect.fail(
          trackerPaginationError('Review request reconciliation exceeded its pagination limit'),
        )
      }
      const url: string = next
      const response = yield* githubJson(provider, url)
      const comments = yield* decode(
        Schema.Array(Schema.Struct({ body: Schema.NullOr(Schema.String) })),
        response.body,
        'Review request comments are invalid',
      )
      if (comments.some((comment) => comment.body === reviewRequestBody(headSha))) {
        return true
      }
      next = yield* Effect.try({
        try: () => parseNextUrl(response.linkHeader, url, provider.apiBaseUrl),
        catch: trackerCause('Review request pagination is invalid', trackerPaginationError),
      })
      pages += 1
    }
    return false
  })
