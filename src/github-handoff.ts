import { Effect } from 'effect'

import type { JsonValue } from './domain.js'
import { TrackerError } from './errors.js'
import {
  githubJson,
  githubPageSize,
  isJsonRecord,
  trackerResponseError,
  type JsonRecord,
} from './github-http.js'
import type { PullRequestObservation } from './handoff.js'
import { isJsonArray } from './json.js'
import type { GitHubProviderConfig } from './tracker-config.js'

const isArray = isJsonArray

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

const requiredString = (number: number, field: string, value: JsonValue | undefined): string => {
  if (typeof value !== 'string') {
    throw pullRequestFieldError(number, field, 'string', value)
  }
  return value
}

const requiredBoolean = (number: number, field: string, value: JsonValue | undefined): boolean => {
  if (typeof value !== 'boolean') {
    throw pullRequestFieldError(number, field, 'boolean', value)
  }
  return value
}

const nullableString = (
  number: number,
  field: string,
  value: JsonValue | undefined,
): string | null => {
  if (value !== null && typeof value !== 'string') {
    throw pullRequestFieldError(number, field, 'string or null', value)
  }
  return value
}

const nullableBoolean = (
  number: number,
  field: string,
  value: JsonValue | undefined,
): boolean | null => {
  if (value !== null && typeof value !== 'boolean') {
    throw pullRequestFieldError(number, field, 'boolean or null', value)
  }
  return value
}

const record = (value: JsonValue | undefined | null, message: string): JsonRecord => {
  if (value === undefined || value === null || !isJsonRecord(value)) {
    throw trackerResponseError(message)
  }
  return value
}

const json = (
  provider: GitHubProviderConfig,
  url: string,
  init?: RequestInit,
): Effect.Effect<JsonValue | null, TrackerError> =>
  githubJson(provider, url, init).pipe(Effect.map(({ body }) => body))

/**
 * Decoding below throws synchronously inside Effect combinators, which Effect records as a defect.
 * Malformed pull-request payloads must surface as a typed `tracker_response` failure so the
 * orchestrator can keep reconciling instead of losing the fiber.
 */
const guarded = <Value>(
  effect: Effect.Effect<Value, TrackerError>,
): Effect.Effect<Value, TrackerError> =>
  effect.pipe(
    Effect.catchAllDefect((defect: unknown) =>
      Effect.fail(
        defect instanceof TrackerError
          ? defect
          : trackerResponseError('GitHub pull request payload could not be decoded', defect),
      ),
    ),
  )

const decodeChecks = (value: JsonValue | undefined): PullRequestObservation['checks'] => {
  if (!isArray(value)) {
    throw new TrackerError({
      category: 'tracker_response',
      message: 'GitHub check-run list is missing',
      retryable: false,
    })
  }
  return value.map((item) => {
    const check = record(item, 'GitHub check run is invalid')
    const name = check['name']
    const status = check['status']
    const conclusion = check['conclusion']
    const url = check['details_url']
    if (
      typeof name !== 'string' ||
      (status !== 'queued' && status !== 'in_progress' && status !== 'completed') ||
      (conclusion !== null && typeof conclusion !== 'string') ||
      (url !== null && typeof url !== 'string')
    ) {
      throw new TrackerError({
        category: 'tracker_response',
        message: 'GitHub check run is incomplete',
        retryable: false,
      })
    }
    return { name, status, conclusion, url }
  })
}

const decodeThreads = (value: JsonValue | undefined): PullRequestObservation['reviewThreads'] => {
  if (!isArray(value)) {
    throw new TrackerError({
      category: 'tracker_response',
      message: 'GitHub review-thread list is missing',
      retryable: false,
    })
  }
  return value.map((item) => {
    const thread = record(item, 'GitHub review thread is invalid')
    const id = thread['id']
    const resolved = thread['isResolved']
    const comments = record(thread['comments'], 'GitHub review comments are missing')
    const nodes = comments['nodes']
    if (typeof id !== 'string' || typeof resolved !== 'boolean' || !isArray(nodes)) {
      throw new TrackerError({
        category: 'tracker_response',
        message: 'GitHub review thread is incomplete',
        retryable: false,
      })
    }
    const first = nodes[0]
    const comment = first === undefined ? null : record(first, 'GitHub review comment is invalid')
    return {
      id,
      resolved,
      body: comment !== null && typeof comment['body'] === 'string' ? comment['body'] : '',
      url: comment !== null && typeof comment['url'] === 'string' ? comment['url'] : null,
    }
  })
}

export type GitHubPullRequestMonitor = Readonly<{
  inspect: (number: number) => Effect.Effect<PullRequestObservation, TrackerError>
  merge: (number: number, expectedHeadSha: string) => Effect.Effect<string, TrackerError>
  resolveThreads: (threadIds: readonly string[]) => Effect.Effect<void, TrackerError>
}>

export const makeGitHubPullRequestMonitor = (
  provider: GitHubProviderConfig,
): GitHubPullRequestMonitor => {
  const prefix = `${provider.apiBaseUrl}/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
  return {
    inspect: (number) =>
      guarded(
        Effect.gen(function* () {
          const pullValue = yield* json(provider, `${prefix}/pulls/${String(number)}`)
          if (!isJsonRecord(pullValue)) {
            throw pullRequestFieldError(number, 'response', 'object', pullValue)
          }
          const pull = pullValue
          const merged = requiredBoolean(number, 'merged', pull['merged'])
          if (merged) {
            const head = pull['head']
            const headSha =
              isJsonRecord(head) && typeof head['sha'] === 'string' ? head['sha'] : null
            const mergeCommitSha =
              typeof pull['merge_commit_sha'] === 'string' ? pull['merge_commit_sha'] : null
            return {
              number,
              url: typeof pull['html_url'] === 'string' ? pull['html_url'] : null,
              headSha,
              merged: true,
              mergeCommitSha,
              mergeable:
                pull['mergeable'] === null || typeof pull['mergeable'] === 'boolean'
                  ? pull['mergeable']
                  : null,
              mergeState:
                typeof pull['mergeable_state'] === 'string' ? pull['mergeable_state'] : null,
              checks: [],
              reviewDecision: null,
              reviewThreads: [],
            }
          }
          const headValue = pull['head']
          if (!isJsonRecord(headValue)) {
            throw pullRequestFieldError(number, 'head', 'object', headValue)
          }
          const headSha = requiredString(number, 'head.sha', headValue['sha'])
          const url = requiredString(number, 'html_url', pull['html_url'])
          const state = typeof pull['state'] === 'string' ? pull['state'] : 'open'
          if (state === 'closed') {
            return {
              number,
              url,
              headSha,
              merged: false,
              closed: true,
              mergeCommitSha: null,
              mergeable: null,
              mergeState: 'closed',
              checks: [],
              reviewDecision: null,
              reviewThreads: [],
            }
          }
          const mergeCommitSha = nullableString(
            number,
            'merge_commit_sha',
            pull['merge_commit_sha'] ?? null,
          )
          const mergeable = nullableBoolean(number, 'mergeable', pull['mergeable'])
          const mergeState = requiredString(number, 'mergeable_state', pull['mergeable_state'])
          const checksResponse = record(
            yield* json(
              provider,
              `${prefix}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=${String(githubPageSize)}`,
            ),
            'GitHub check-run response is invalid',
          )
          const graphResponse = record(
            yield* json(provider, `${provider.apiBaseUrl.replace(/\/$/u, '')}/graphql`, {
              method: 'POST',
              body: JSON.stringify({
                query:
                  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{body url}}}}}}}',
                variables: { owner: provider.owner, name: provider.repository, number },
              }),
            }),
            'GitHub GraphQL response is invalid',
          )
          const data = record(graphResponse['data'], 'GitHub GraphQL data is missing')
          const repository = record(data['repository'], 'GitHub GraphQL repository is missing')
          const graphPull = record(
            repository['pullRequest'],
            'GitHub GraphQL pull request is missing',
          )
          const reviewDecision = graphPull['reviewDecision']
          const threads = record(graphPull['reviewThreads'], 'GitHub review threads are missing')
          if (reviewDecision !== null && typeof reviewDecision !== 'string') {
            throw new TrackerError({
              category: 'tracker_response',
              message: 'GitHub review decision is invalid',
              retryable: false,
            })
          }
          return {
            number,
            url,
            headSha,
            merged: false,
            closed: false,
            mergeCommitSha,
            mergeable,
            mergeState,
            checks: decodeChecks(checksResponse['check_runs']),
            reviewDecision,
            reviewThreads: decodeThreads(threads['nodes']),
          }
        }),
      ),
    merge: (number, expectedHeadSha) =>
      guarded(
        json(provider, `${prefix}/pulls/${String(number)}/merge`, {
          method: 'PUT',
          body: JSON.stringify({ sha: expectedHeadSha, merge_method: 'squash' }),
        }).pipe(
          Effect.flatMap((value) => {
            const response = record(value, 'GitHub merge response is invalid')
            const merged = response['merged']
            const sha = response['sha']
            const message = response['message']
            if (merged !== true || typeof sha !== 'string') {
              return Effect.fail(
                new TrackerError({
                  category: 'tracker_status',
                  message:
                    typeof message === 'string' ? message : 'GitHub did not merge the pull request',
                  retryable: false,
                }),
              )
            }
            return Effect.succeed(sha)
          }),
        ),
      ),
    resolveThreads: (threadIds) =>
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
  }
}
