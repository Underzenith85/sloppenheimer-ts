import type * as HttpClient from '@effect/platform/HttpClient'
import { Effect, Schema } from 'effect'

import type { JsonValue } from '@sloppenheimer/core/domain/domain.js'
import { unknownRecord } from '@sloppenheimer/core/support/schema.js'
import { TrackerError } from '@sloppenheimer/core/domain/errors.js'
import {
  githubJson,
  githubMaxPages,
  githubPageSize,
  parseNextUrl,
  trackerCause,
  trackerPaginationError,
  withBoundHttpClient,
  type GitHubHttpResult,
  type GitHubRequestInit,
} from './client.js'
import type {
  CodexReviewObservation,
  PullRequestObservation,
} from '@sloppenheimer/core/domain/handoff.js'
import {
  closedObservation,
  decode,
  decodeChecks,
  decodeCodexReview,
  decodeThreads,
  field,
  openPullRequestFields,
  pullRequestFieldError,
} from './pull-request-payloads.js'
import type { GitHubProviderConfig } from './provider.js'

/**
 * The GitHub pull-request monitor: everything the handoff runtime observes about one pull request,
 * and the three writes it makes — merge under a lease, request a review, resolve review threads.
 *
 * Reading a payload is `pull-request-payloads.ts`; this module decides what to fetch.
 */

/** GraphQL is one endpoint on the same host, not a path under the repository prefix. */
const graphqlUrl = (provider: GitHubProviderConfig): string =>
  `${provider.apiBaseUrl.replace(/\/$/u, '')}/graphql`

const json = (
  provider: GitHubProviderConfig,
  url: string,
  init?: GitHubRequestInit,
): Effect.Effect<JsonValue | null, TrackerError> =>
  githubJson(provider, url, init).pipe(Effect.map(({ body }) => body))

const fetchCodexReview = (
  provider: GitHubProviderConfig,
  prefix: string,
  number: number,
): Effect.Effect<CodexReviewObservation | null, TrackerError> =>
  Effect.gen(function* () {
    let nextUrl: string | null =
      `${prefix}/issues/${String(number)}/comments?per_page=${String(githubPageSize)}`
    let pages = 0
    let latest: CodexReviewObservation | null = null
    while (nextUrl !== null) {
      if (pages >= githubMaxPages) {
        return yield* Effect.fail(
          trackerPaginationError('GitHub pull request comment pagination exceeded its limit'),
        )
      }
      const requestUrl: string = nextUrl
      const response: GitHubHttpResult = yield* githubJson(provider, requestUrl)
      const decoded = yield* decodeCodexReview(response.body)
      if (decoded !== null) {
        latest = decoded
      }
      nextUrl = yield* Effect.try({
        try: (): string | null =>
          parseNextUrl(response.linkHeader, requestUrl, provider.apiBaseUrl),
        catch: trackerCause(
          'GitHub pull request comment pagination could not be decoded',
          trackerPaginationError,
        ),
      })
      pages += 1
    }
    return latest
  })

/**
 * The review decision and review threads, which the REST pull-request payload does not carry. The
 * thread nodes are returned undecoded, so the caller reads them in the order it assembles the
 * observation.
 */
const fetchReviewGraph = (
  provider: GitHubProviderConfig,
  number: number,
): Effect.Effect<Readonly<{ reviewDecision: string | null; threadNodes: unknown }>, TrackerError> =>
  Effect.gen(function* () {
    const graphResponse = yield* decode(
      unknownRecord,
      yield* json(provider, graphqlUrl(provider), {
        method: 'POST',
        body: JSON.stringify({
          query:
            'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{body url commit{oid}}}}}}}}',
          variables: { owner: provider.owner, name: provider.repository, number },
        }),
      }),
      'GitHub GraphQL response is invalid',
    )
    const data = yield* decode(
      unknownRecord,
      graphResponse['data'],
      'GitHub GraphQL data is missing',
    )
    const repository = yield* decode(
      unknownRecord,
      data['repository'],
      'GitHub GraphQL repository is missing',
    )
    const graphPull = yield* decode(
      unknownRecord,
      repository['pullRequest'],
      'GitHub GraphQL pull request is missing',
    )
    const reviewDecision = yield* decode(
      Schema.NullOr(Schema.String),
      graphPull['reviewDecision'],
      'GitHub review decision is invalid',
    )
    const threads = yield* decode(
      unknownRecord,
      graphPull['reviewThreads'],
      'GitHub review threads are missing',
    )
    return { reviewDecision, threadNodes: threads['nodes'] }
  })

export type GitHubPullRequestMonitor = Readonly<{
  inspect: (number: number) => Effect.Effect<PullRequestObservation, TrackerError>
  merge: (number: number, expectedHeadSha: string) => Effect.Effect<string, TrackerError>
  requestReview: (number: number, expectedHeadSha: string) => Effect.Effect<void, TrackerError>
  resolveThreads: (threadIds: readonly string[]) => Effect.Effect<void, TrackerError>
}>

/**
 * Everything the handoff runtime observes about one pull request.
 *
 * A closed pull request is read from its own payload alone: it has no checks, review decision, or
 * threads left to act on. An open one costs three further reads — the head's check runs, the
 * reviewer's comment history, and the GraphQL review graph — issued in that order so the cheapest
 * failure is reported first.
 */
const inspectPullRequest = (
  provider: GitHubProviderConfig,
  prefix: string,
  number: number,
): Effect.Effect<PullRequestObservation, TrackerError> =>
  Effect.gen(function* () {
    const pullValue = yield* json(provider, `${prefix}/pulls/${String(number)}`)
    const pull = yield* field(unknownRecord, number, 'response', 'object', pullValue)
    const state = yield* field(
      Schema.Literal('open', 'closed'),
      number,
      'state',
      '"open" or "closed"',
      pull['state'] as JsonValue | undefined,
    )
    const merged = yield* field(
      Schema.Boolean,
      number,
      'merged',
      'boolean',
      pull['merged'] as JsonValue | undefined,
    )
    if (merged && state !== 'closed') {
      return yield* Effect.fail(
        pullRequestFieldError(number, 'state', '"closed" for a merged pull request', state),
      )
    }
    if (state === 'closed') {
      return closedObservation(number, merged, pull)
    }
    const fields = yield* openPullRequestFields(number, pull)
    const checksResponse = yield* decode(
      unknownRecord,
      yield* json(
        provider,
        `${prefix}/commits/${encodeURIComponent(fields.headSha)}/check-runs?per_page=${String(githubPageSize)}`,
      ),
      'GitHub check-run response is invalid',
    )
    const codexReview = yield* fetchCodexReview(provider, prefix, number)
    const graph = yield* fetchReviewGraph(provider, number)
    return {
      number,
      state,
      ...fields,
      merged: false,
      checks: yield* decodeChecks(checksResponse['check_runs']),
      reviewDecision: graph.reviewDecision,
      reviewThreads: yield* decodeThreads(graph.threadNodes),
      codexReview,
    }
  })

/** Merges under the caller's lease: GitHub refuses the merge if the head moved. */
const mergePullRequest = (
  provider: GitHubProviderConfig,
  prefix: string,
  number: number,
  expectedHeadSha: string,
): Effect.Effect<string, TrackerError> =>
  Effect.gen(function* () {
    const value = yield* json(provider, `${prefix}/pulls/${String(number)}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ sha: expectedHeadSha, merge_method: 'squash' }),
    })
    const response = yield* decode(unknownRecord, value, 'GitHub merge response is invalid')
    const merged = response['merged']
    const sha = response['sha']
    const message = response['message']
    if (merged !== true || typeof sha !== 'string') {
      return yield* Effect.fail(
        new TrackerError({
          category: 'tracker_status',
          message: typeof message === 'string' ? message : 'GitHub did not merge the pull request',
          retryable: false,
        }),
      )
    }
    return sha
  })

/**
 * Asks the code-review provider for a review of the head the caller observed. The head is re-read
 * first, so a review is never requested for a commit the caller has not seen.
 */
const requestCodexReview = (
  provider: GitHubProviderConfig,
  prefix: string,
  number: number,
  expectedHeadSha: string,
): Effect.Effect<void, TrackerError> =>
  Effect.gen(function* () {
    const pull = yield* decode(
      unknownRecord,
      yield* json(provider, `${prefix}/pulls/${String(number)}`),
      'GitHub pull request response is invalid',
    )
    const head = yield* decode(unknownRecord, pull['head'], 'GitHub pull request head is missing')
    if (head['sha'] !== expectedHeadSha) {
      return yield* Effect.fail(
        new TrackerError({
          category: 'tracker_status',
          message: 'GitHub pull request head changed before Codex review was requested',
          retryable: true,
        }),
      )
    }
    yield* json(provider, `${prefix}/issues/${String(number)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '@codex review' }),
    })
  })

/** Resolves review threads one at a time, so a rejected mutation stops the rest. */
const resolveReviewThreads = (
  provider: GitHubProviderConfig,
  threadIds: readonly string[],
): Effect.Effect<void, TrackerError> =>
  Effect.forEach(
    threadIds,
    (threadId) =>
      json(provider, graphqlUrl(provider), {
        method: 'POST',
        body: JSON.stringify({
          query:
            'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}',
          variables: { threadId },
        }),
      }),
    { concurrency: 1, discard: true },
  )

export const makeGitHubPullRequestMonitor = (
  provider: GitHubProviderConfig,
  httpClient?: HttpClient.HttpClient,
): GitHubPullRequestMonitor => {
  const prefix = `${provider.apiBaseUrl}/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
  const bindClient = withBoundHttpClient(httpClient)
  return {
    inspect: (number) => bindClient(inspectPullRequest(provider, prefix, number)),
    merge: (number, expectedHeadSha) =>
      bindClient(mergePullRequest(provider, prefix, number, expectedHeadSha)),
    requestReview: (number, expectedHeadSha) =>
      bindClient(requestCodexReview(provider, prefix, number, expectedHeadSha)),
    resolveThreads: (threadIds) => bindClient(resolveReviewThreads(provider, threadIds)),
  }
}
