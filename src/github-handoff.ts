import { Effect } from 'effect'

import type { JsonValue } from './domain.js'
import { TrackerError } from './errors.js'
import type { PullRequestObservation } from './handoff.js'
import type { GitHubProviderConfig } from './workflow.js'

type JsonRecord = Record<string, JsonValue>
const githubRequestTimeoutMs = 30_000

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }
  return typeof value === 'object' && value !== null && Object.values(value).every(isJsonValue)
}

const isRecord = (value: JsonValue): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isArray = (value: JsonValue | undefined): value is readonly JsonValue[] =>
  Array.isArray(value)

const record = (value: JsonValue | undefined, message: string): JsonRecord => {
  if (value === undefined || !isRecord(value)) {
    throw new TrackerError({ category: 'tracker_response', message, retryable: false })
  }
  return value
}

const json = (
  provider: GitHubProviderConfig,
  url: string,
  init?: RequestInit,
): Effect.Effect<JsonValue, TrackerError> =>
  Effect.tryPromise({
    try: async () => {
      const headers = new Headers(init?.headers)
      headers.set('Accept', 'application/vnd.github+json')
      headers.set('Authorization', `Bearer ${provider.token}`)
      headers.set('Content-Type', 'application/json')
      headers.set('User-Agent', 'symphony-ts/0.1')
      headers.set('X-GitHub-Api-Version', '2026-03-10')
      const response = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(githubRequestTimeoutMs),
      })
      if (!response.ok) {
        throw new TrackerError({
          category: 'tracker_status',
          message: `GitHub returned HTTP ${String(response.status)}`,
          retryable: response.status >= 500 || response.status === 409,
        })
      }
      const value: unknown = await response.json()
      if (!isJsonValue(value)) {
        throw new TrackerError({
          category: 'tracker_response',
          message: 'GitHub returned non-JSON data',
          retryable: false,
        })
      }
      return value
    },
    catch: (cause: unknown) =>
      cause instanceof TrackerError
        ? cause
        : new TrackerError({
            category: 'tracker_request',
            message: 'GitHub pull request request failed',
            retryable: true,
            cause,
          }),
  })

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
      Effect.gen(function* () {
        const pull = record(
          yield* json(provider, `${prefix}/pulls/${String(number)}`),
          'GitHub pull request is invalid',
        )
        const head = record(pull['head'], 'GitHub pull request head is missing')
        const headSha = head['sha']
        const url = pull['html_url']
        const merged = pull['merged']
        const mergeable = pull['mergeable']
        const mergeState = pull['mergeable_state']
        const mergeCommitSha = pull['merge_commit_sha']
        if (
          typeof headSha !== 'string' ||
          typeof url !== 'string' ||
          typeof merged !== 'boolean' ||
          (mergeable !== null && typeof mergeable !== 'boolean') ||
          typeof mergeState !== 'string' ||
          (mergeCommitSha !== null && typeof mergeCommitSha !== 'string')
        ) {
          throw new TrackerError({
            category: 'tracker_response',
            message: 'GitHub pull request status is incomplete',
            retryable: false,
          })
        }
        const checksResponse = record(
          yield* json(
            provider,
            `${prefix}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`,
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
          merged,
          mergeCommitSha,
          mergeable,
          mergeState,
          checks: decodeChecks(checksResponse['check_runs']),
          reviewDecision,
          reviewThreads: decodeThreads(threads['nodes']),
        }
      }),
    merge: (number, expectedHeadSha) =>
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
