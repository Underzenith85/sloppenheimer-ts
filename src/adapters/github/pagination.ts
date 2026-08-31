import { Effect } from 'effect'

import type { JsonValue } from '../../domain/domain.js'
import { TrackerError } from '../../errors.js'
import type { GitHubProviderConfig } from './provider.js'
import {
  githubJson,
  githubMaxPages,
  parseNextUrl,
  trackerPaginationError,
  trackerResponseError,
} from './client.js'

/**
 * Follows `rel="next"` from one scoped list endpoint, decoding each page as it arrives.
 *
 * Pagination is bounded in two directions: a repeated URL is a cycle and more than
 * `githubMaxPages` pages is a runaway list, and both are pagination integrity failures rather than
 * a silently truncated read.
 */
export const paginate = <Value>(
  provider: GitHubProviderConfig,
  firstUrl: string,
  decode: (body: JsonValue) => Value,
  combine: (accumulated: readonly Value[]) => readonly Value[] = (values) => values,
): Effect.Effect<readonly Value[], TrackerError> => {
  const fetchPage = (
    url: string,
    visitedUrls: ReadonlySet<string>,
    pageCount: number,
  ): Effect.Effect<readonly Value[], TrackerError> =>
    Effect.suspend(() => {
      if (visitedUrls.has(url)) {
        return Effect.fail(trackerPaginationError('GitHub pagination contains a cycle'))
      }
      if (pageCount > githubMaxPages) {
        return Effect.fail(
          trackerPaginationError(
            `GitHub pagination exceeded ${String(githubMaxPages)} pages for a single scoped read`,
          ),
        )
      }
      return githubJson(provider, url).pipe(
        Effect.flatMap(({ body, linkHeader }) =>
          Effect.try({
            try: () => ({
              value: decode(body ?? null),
              nextUrl: parseNextUrl(linkHeader, url, provider.apiBaseUrl),
            }),
            catch: (cause: unknown) =>
              cause instanceof TrackerError
                ? cause
                : trackerResponseError('GitHub returned an undecodable page', cause),
          }),
        ),
        Effect.flatMap(({ value, nextUrl }) =>
          nextUrl === null
            ? Effect.succeed([value])
            : fetchPage(nextUrl, new Set([...visitedUrls, url]), pageCount + 1).pipe(
                Effect.map((rest) => [value, ...rest]),
              ),
        ),
      )
    })
  return fetchPage(firstUrl, new Set(), 1).pipe(Effect.map(combine))
}
