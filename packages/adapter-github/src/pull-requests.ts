import type * as HttpClient from '@effect/platform/HttpClient'
import { Effect, Schema } from 'effect'

import type { JsonValue } from '@symphony/core/domain/domain.js'
import { unknownRecord } from '@symphony/core/support/schema.js'
import { TrackerError } from '@symphony/core/domain/errors.js'
import {
  decodeTracker,
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
} from '@symphony/core/domain/handoff.js'
import type { GitHubProviderConfig } from './provider.js'

const checkRun = Schema.Struct({
  name: Schema.String,
  status: Schema.Literal('queued', 'in_progress', 'completed'),
  conclusion: Schema.NullOr(Schema.String),
  details_url: Schema.NullOr(Schema.String),
})
const checkRuns = Schema.Array(checkRun)
const reviewComment = Schema.Struct({
  body: Schema.optional(Schema.Unknown),
  url: Schema.optional(Schema.Unknown),
  commit: Schema.optional(Schema.Unknown),
})
const reviewThread = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  comments: Schema.Struct({ nodes: Schema.Array(Schema.Unknown) }),
})
const reviewThreads = Schema.Array(reviewThread)
const codexComments = Schema.Array(Schema.Unknown)
const codexComment = Schema.Struct({
  author: Schema.optional(Schema.Unknown),
  user: Schema.optional(Schema.Unknown),
  body: Schema.optional(Schema.Unknown),
})

const decode = <Value, Encoded>(
  schema: Schema.Schema<Value, Encoded>,
  value: unknown,
  message: string,
): Effect.Effect<Value, TrackerError> => decodeTracker(schema, value, trackerCause(message))

const safeValueType = (value: JsonValue | undefined): string => {
  if (value === undefined) {
    return 'missing'
  }
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  return typeof value
}

const pullRequestFieldError = (
  number: number,
  field: string,
  expected: string,
  value: JsonValue | undefined,
): TrackerError =>
  new TrackerError({
    category: 'tracker_response',
    message: `GitHub pull request #${String(number)} field ${JSON.stringify(field)} is invalid: expected ${expected}, received ${safeValueType(value)}`,
    retryable: false,
  })

/** {@link decode} for one field, reporting the key it was read under rather than the whole record. */
const field = <Value, Encoded>(
  schema: Schema.Schema<Value, Encoded>,
  number: number,
  name: string,
  expected: string,
  value: JsonValue | undefined,
): Effect.Effect<Value, TrackerError> =>
  decodeTracker(schema, value, () => pullRequestFieldError(number, name, expected, value))

const json = (
  provider: GitHubProviderConfig,
  url: string,
  init?: GitHubRequestInit,
): Effect.Effect<JsonValue | null, TrackerError> =>
  githubJson(provider, url, init).pipe(Effect.map(({ body }) => body))

const decodeChecks = (
  value: unknown,
): Effect.Effect<PullRequestObservation['checks'], TrackerError> =>
  decode(checkRuns, value, 'GitHub check-run list is invalid').pipe(
    Effect.map((checks) =>
      checks.map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        url: check.details_url,
      })),
    ),
  )

const decodeThreads = (
  value: unknown,
): Effect.Effect<PullRequestObservation['reviewThreads'], TrackerError> =>
  Effect.gen(function* () {
    const threads = yield* decode(reviewThreads, value, 'GitHub review-thread list is invalid')
    return yield* Effect.forEach(threads, (thread) =>
      Effect.gen(function* () {
        const first = thread.comments.nodes[0]
        const comment =
          first === undefined
            ? null
            : yield* decode(reviewComment, first, 'GitHub review comment is invalid')
        const commit =
          comment === null ? null : Schema.decodeUnknownOption(unknownRecord)(comment.commit)
        return {
          id: thread.id,
          resolved: thread.isResolved,
          body: comment !== null && typeof comment.body === 'string' ? comment.body : '',
          url: comment !== null && typeof comment.url === 'string' ? comment.url : null,
          commentHeadSha:
            commit !== null && commit._tag === 'Some' && typeof commit.value['oid'] === 'string'
              ? commit.value['oid']
              : null,
        }
      }),
    )
  })

const decodeCodexReview = (
  value: unknown,
): Effect.Effect<CodexReviewObservation | null, TrackerError> =>
  Effect.gen(function* () {
    const comments = yield* decode(
      codexComments,
      value,
      'GitHub pull request comment list is missing',
    )
    for (const item of [...comments].reverse()) {
      const comment = yield* decode(codexComment, item, 'GitHub pull request comment is invalid')
      const author = comment.author ?? comment.user
      const body = comment.body
      const authorRecord = Schema.decodeUnknownOption(unknownRecord)(author)
      if (authorRecord._tag === 'None' || typeof body !== 'string') {
        continue
      }
      const login = authorRecord.value['login']
      const isCodexConnector =
        login === 'chatgpt-codex-connector' || login === 'chatgpt-codex-connector[bot]'
      if (!isCodexConnector || !body.includes('<!-- codex-pull-request-review-summary -->')) {
        continue
      }
      const head = /\|\s*`([0-9a-f]{7,40})`\s*\|/u.exec(body)?.[1]
      if (head === undefined) {
        continue
      }
      if (body.includes('✅ **Completed**')) {
        return { headShaPrefix: head, status: 'completed' }
      }
      if (body.includes('🔄 **Running**')) {
        return { headShaPrefix: head, status: 'pending' }
      }
    }
    return null
  })

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

export type GitHubPullRequestMonitor = Readonly<{
  inspect: (number: number) => Effect.Effect<PullRequestObservation, TrackerError>
  merge: (number: number, expectedHeadSha: string) => Effect.Effect<string, TrackerError>
  requestReview: (number: number, expectedHeadSha: string) => Effect.Effect<void, TrackerError>
  resolveThreads: (threadIds: readonly string[]) => Effect.Effect<void, TrackerError>
}>

export const makeGitHubPullRequestMonitor = (
  provider: GitHubProviderConfig,
  httpClient?: HttpClient.HttpClient,
): GitHubPullRequestMonitor => {
  const prefix = `${provider.apiBaseUrl}/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
  const bindClient = withBoundHttpClient(httpClient)
  return {
    inspect: (number) =>
      bindClient(
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
          if (merged) {
            if (state !== 'closed') {
              return yield* Effect.fail(
                pullRequestFieldError(number, 'state', '"closed" for a merged pull request', state),
              )
            }
            const head = Schema.decodeUnknownOption(unknownRecord)(pull['head'])
            const headSha =
              head._tag === 'Some' && typeof head.value['sha'] === 'string'
                ? head.value['sha']
                : null
            const mergeCommitSha =
              typeof pull['merge_commit_sha'] === 'string' ? pull['merge_commit_sha'] : null
            return {
              number,
              state,
              url: typeof pull['html_url'] === 'string' ? pull['html_url'] : null,
              headSha,
              merged: true,
              mergeCommitSha,
              // GitHub reports when the merge happened; keeping it lets a handoff observed after
              // a restart report the time it actually completed rather than the time we noticed.
              mergedAt: typeof pull['merged_at'] === 'string' ? pull['merged_at'] : null,
              mergeable:
                pull['mergeable'] === null || typeof pull['mergeable'] === 'boolean'
                  ? pull['mergeable']
                  : null,
              mergeState:
                typeof pull['mergeable_state'] === 'string' ? pull['mergeable_state'] : null,
              checks: [],
              reviewDecision: null,
              reviewThreads: [],
              codexReview: null,
            }
          }
          if (state === 'closed') {
            const head = Schema.decodeUnknownOption(unknownRecord)(pull['head'])
            return {
              number,
              state,
              url: typeof pull['html_url'] === 'string' ? pull['html_url'] : null,
              headSha:
                head._tag === 'Some' && typeof head.value['sha'] === 'string'
                  ? head.value['sha']
                  : null,
              merged: false,
              mergeCommitSha:
                typeof pull['merge_commit_sha'] === 'string' ? pull['merge_commit_sha'] : null,
              mergeable:
                pull['mergeable'] === null || typeof pull['mergeable'] === 'boolean'
                  ? pull['mergeable']
                  : null,
              mergeState:
                typeof pull['mergeable_state'] === 'string' ? pull['mergeable_state'] : null,
              checks: [],
              reviewDecision: null,
              reviewThreads: [],
              codexReview: null,
            }
          }
          const headValue = pull['head']
          const head = yield* field(
            unknownRecord,
            number,
            'head',
            'object',
            headValue as JsonValue | undefined,
          )
          const headSha = yield* field(
            Schema.String,
            number,
            'head.sha',
            'string',
            head['sha'] as JsonValue | undefined,
          )
          const url = yield* field(
            Schema.String,
            number,
            'html_url',
            'string',
            pull['html_url'] as JsonValue | undefined,
          )
          const mergeCommitSha = yield* field(
            Schema.NullOr(Schema.String),
            number,
            'merge_commit_sha',
            'string or null',
            (pull['merge_commit_sha'] ?? null) as JsonValue,
          )
          const mergeable = yield* field(
            Schema.NullOr(Schema.Boolean),
            number,
            'mergeable',
            'boolean or null',
            pull['mergeable'] as JsonValue | undefined,
          )
          const mergeState = yield* field(
            Schema.String,
            number,
            'mergeable_state',
            'string',
            pull['mergeable_state'] as JsonValue | undefined,
          )
          const checksResponse = yield* decode(
            unknownRecord,
            yield* json(
              provider,
              `${prefix}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=${String(githubPageSize)}`,
            ),
            'GitHub check-run response is invalid',
          )
          const codexReview = yield* fetchCodexReview(provider, prefix, number)
          const graphResponse = yield* decode(
            unknownRecord,
            yield* json(provider, `${provider.apiBaseUrl.replace(/\/$/u, '')}/graphql`, {
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
          return {
            number,
            state,
            url,
            headSha,
            merged: false,
            mergeCommitSha,
            mergeable,
            mergeState,
            checks: yield* decodeChecks(checksResponse['check_runs']),
            reviewDecision,
            reviewThreads: yield* decodeThreads(threads['nodes']),
            codexReview,
          }
        }),
      ),
    merge: (number, expectedHeadSha) =>
      bindClient(
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
                message:
                  typeof message === 'string' ? message : 'GitHub did not merge the pull request',
                retryable: false,
              }),
            )
          }
          return sha
        }),
      ),
    requestReview: (number, expectedHeadSha) =>
      bindClient(
        Effect.gen(function* () {
          const pull = yield* decode(
            unknownRecord,
            yield* json(provider, `${prefix}/pulls/${String(number)}`),
            'GitHub pull request response is invalid',
          )
          const head = yield* decode(
            unknownRecord,
            pull['head'],
            'GitHub pull request head is missing',
          )
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
        }),
      ),
    resolveThreads: (threadIds) =>
      bindClient(
        Effect.forEach(
          threadIds,
          (threadId) =>
            json(provider, `${provider.apiBaseUrl.replace(/\/$/u, '')}/graphql`, {
              method: 'POST',
              body: JSON.stringify({
                query:
                  'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}',
                variables: { threadId },
              }),
            }),
          { concurrency: 1, discard: true },
        ),
      ),
  }
}
