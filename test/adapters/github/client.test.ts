import * as HttpClient from '@effect/platform/HttpClient'
import * as HttpClientError from '@effect/platform/HttpClientError'
import type * as HttpClientRequest from '@effect/platform/HttpClientRequest'
import * as HttpClientResponse from '@effect/platform/HttpClientResponse'
import { it } from '@effect/vitest'
import { Clock, Effect, Fiber, Layer, Metric, Redacted, TestClock } from 'effect'
import { afterEach, describe, expect, vi } from 'vitest'

import { githubJson, type GitHubHttpResult } from '@sloppenheimer/adapter-github/client.js'
import { makeGitHubTracker } from '@sloppenheimer/adapter-github/issues.js'
import { githubRequestDuration } from '@sloppenheimer/adapter-github/observability.js'
import { issueId, issueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import type { GitHubProviderConfig } from '@sloppenheimer/adapter-github'
import type { TrackerError } from '@sloppenheimer/core/domain/errors.js'

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'sloppenheimer',
  token: Redacted.make('secret'),
  tokenEnvironmentName: 'GITHUB_TOKEN',
  apiBaseUrl: 'https://api.example.test',
  baseBranch: 'main',
}

const issuesUrl = 'https://api.example.test/repos/example/sloppenheimer/issues'

/** A client bound through a layer: the adapter never reaches for global `fetch`. */
const clientLayer = (
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, respond(request))),
    ),
  )

/** The request under test, against the client layer this case installs. */
const run = (
  effect: Effect.Effect<GitHubHttpResult, TrackerError>,
  layer: Layer.Layer<HttpClient.HttpClient>,
): Effect.Effect<GitHubHttpResult, TrackerError> => effect.pipe(Effect.provide(layer))

/** The same, read off the error channel for a case that expects the transport to refuse. */
const runFailure = (
  effect: Effect.Effect<GitHubHttpResult, TrackerError>,
  layer: Layer.Layer<HttpClient.HttpClient>,
): Effect.Effect<TrackerError, GitHubHttpResult> => Effect.flip(effect).pipe(Effect.provide(layer))

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('GitHub transport client injection', (): void => {
  it.effect('sends every request through the provided client rather than global fetch', () =>
    Effect.gen(function* () {
      const unusable = vi.fn((): never => {
        throw new Error('global fetch must not be used')
      })
      vi.stubGlobal('fetch', unusable)
      const requests: HttpClientRequest.HttpClientRequest[] = []
      const beforeDurationCount = (yield* Metric.value(githubRequestDuration)).count

      const result = yield* run(
        githubJson(provider, issuesUrl),
        clientLayer((request) => {
          requests.push(request)
          return Response.json([], { headers: { Link: `<${issuesUrl}?page=2>; rel="next"` } })
        }),
      )

      expect(unusable).not.toHaveBeenCalled()
      expect(requests).toHaveLength(1)
      expect((yield* Metric.value(githubRequestDuration)).count).toBe(beforeDurationCount + 1)
      expect(result).toEqual({
        status: 200,
        body: [],
        linkHeader: `<${issuesUrl}?page=2>; rel="next"`,
      })
    }),
  )

  it.effect('applies the GitHub authentication, agent, and API version headers', () =>
    Effect.gen(function* () {
      const observed: HttpClientRequest.HttpClientRequest[] = []

      yield* run(
        githubJson(provider, issuesUrl),
        clientLayer((request) => {
          observed.push(request)
          return Response.json([])
        }),
      )

      expect(observed[0]?.headers).toMatchObject({
        accept: 'application/vnd.github+json',
        authorization: 'Bearer secret',
        'user-agent': 'sloppenheimer-ts/0.1',
        'x-github-api-version': '2026-03-10',
      })
      expect(observed[0]?.headers['content-type']).toBeUndefined()
    }),
  )

  it.effect('declares a JSON content type only for a request that carries a body', () =>
    Effect.gen(function* () {
      const observed: HttpClientRequest.HttpClientRequest[] = []

      yield* run(
        githubJson(provider, `${issuesUrl}/1/comments`, {
          method: 'POST',
          body: JSON.stringify({ body: 'hello' }),
        }),
        clientLayer((request) => {
          observed.push(request)
          return Response.json({ html_url: 'https://example.test/comment/1' }, { status: 201 })
        }),
      )

      expect(observed[0]?.method).toBe('POST')
      expect(observed[0]?.headers['content-type']).toBe('application/json')
    }),
  )
})

describe('GitHub transport error mapping', (): void => {
  it.effect('maps a secondary rate limit onto its advertised delay', () =>
    Effect.gen(function* () {
      const error = yield* runFailure(
        githubJson(provider, issuesUrl),
        clientLayer(() => new Response(null, { status: 429, headers: { 'Retry-After': '30' } })),
      )

      expect(error.category).toBe('tracker_rate_limited')
      expect(error.retryable).toBe(true)
      expect(error.retryAfterMs).toBe(30_000)
    }),
  )

  it.effect('maps an exhausted primary rate limit onto its reset window', () =>
    Effect.gen(function* () {
      // The adapter subtracts the instant it reads from the clock (#184) from this reset, so the
      // header is dated from the same clock. Taken from the ambient one it would be decades ahead
      // of the test clock's epoch, and the window this case exists to check would go untested.
      const reset = Math.floor((yield* Clock.currentTimeMillis) / 1_000) + 120

      const error = yield* runFailure(
        githubJson(provider, issuesUrl),
        clientLayer(
          () =>
            new Response(null, {
              status: 403,
              headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
            }),
        ),
      )

      expect(error.category).toBe('tracker_rate_limited')
      expect(error.retryable).toBe(true)
      // Exact rather than a lower bound: the clock no longer drifts between the two reads.
      expect(error.retryAfterMs).toBe(120_000)
    }),
  )

  it.effect('keeps server statuses retryable and client statuses terminal', () =>
    Effect.gen(function* () {
      const serverError = yield* runFailure(
        githubJson(provider, issuesUrl),
        clientLayer(() => new Response(null, { status: 502 })),
      )
      const clientError = yield* runFailure(
        githubJson(provider, issuesUrl),
        clientLayer(() => new Response(null, { status: 404 })),
      )

      expect(serverError.category).toBe('tracker_status')
      expect(serverError.retryable).toBe(true)
      expect(clientError.category).toBe('tracker_not_found')
      expect(clientError.message).toBe('GitHub returned HTTP 404')
      expect(clientError.retryable).toBe(false)
    }),
  )

  it.effect('returns an accepted non-success status without decoding its body', () =>
    Effect.gen(function* () {
      const result = yield* run(
        githubJson(provider, `${issuesUrl}/1/labels/bug`, { method: 'DELETE' }, [404]),
        clientLayer(() => new Response('not json', { status: 404 })),
      )

      expect(result).toEqual({ status: 404, body: null, linkHeader: null })
    }),
  )

  it.effect('returns an empty body for a no-content response', () =>
    Effect.gen(function* () {
      const result = yield* run(
        githubJson(provider, `${issuesUrl}/1`, { method: 'PATCH', body: '{}' }),
        clientLayer(() => new Response(null, { status: 204 })),
      )

      expect(result).toEqual({ status: 204, body: null, linkHeader: null })
    }),
  )

  it.effect('rejects a malformed JSON payload as a response failure', () =>
    Effect.gen(function* () {
      const error = yield* runFailure(
        githubJson(provider, issuesUrl),
        clientLayer(
          () => new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
        ),
      )

      expect(error.category).toBe('tracker_response')
      expect(error.retryable).toBe(false)
    }),
  )

  it.effect('reports a transport failure as retryable', () =>
    Effect.gen(function* () {
      const error = yield* runFailure(
        githubJson(provider, issuesUrl),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.fail(
              new HttpClientError.RequestError({
                request,
                reason: 'Transport',
                cause: new Error('connection reset'),
              }),
            ),
          ),
        ),
      )

      expect(error.category).toBe('tracker_request')
      expect(error.message).toBe('GitHub request failed')
      expect(error.retryable).toBe(true)
    }),
  )

  it.effect('fails a request that outlives the transport deadline', () =>
    Effect.gen(function* () {
      const attempt = yield* Effect.fork(
        Effect.flip(githubJson(provider, issuesUrl)).pipe(
          Effect.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.never),
            ),
          ),
        ),
      )
      yield* TestClock.adjust('31 seconds')
      const error = yield* Fiber.join(attempt)

      expect(error.category).toBe('tracker_request')
      expect(error.retryable).toBe(true)
    }),
  )
})

describe('GitHub adapter client binding', (): void => {
  it.effect('runs promise-shaped tool requests through the bound client', () =>
    Effect.gen(function* () {
      const unusable = vi.fn((): never => {
        throw new Error('global fetch must not be used')
      })
      vi.stubGlobal('fetch', unusable)
      const requests: HttpClientRequest.HttpClientRequest[] = []
      const client = HttpClient.make((request) => {
        requests.push(request)
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ html_url: 'https://example.test/comment/1' }, { status: 201 }),
          ),
        )
      })

      const tracker = yield* makeGitHubTracker(provider, client)
      // `executeTool` is the promise-shaped host-tool boundary, so it is awaited rather than
      // yielded even here.
      const result = yield* Effect.promise(() =>
        tracker.executeTool(
          'github_add_comment',
          { body: 'hello' },
          {
            issueId: issueId('7'),
            issueIdentifier: issueIdentifier('example/sloppenheimer#7'),
            nativeRef: { owner: 'example', repository: 'sloppenheimer', issue_number: 7 },
          },
        ),
      )

      expect(unusable).not.toHaveBeenCalled()
      expect(result).toEqual({
        success: true,
        data: { issue_number: 7, comment_url: 'https://example.test/comment/1' },
      })
      expect(requests[0]?.url).toBe(
        'https://api.example.test/repos/example/sloppenheimer/issues/7/comments',
      )
    }),
  )

  it.effect('binds the same client to the operations that stay in Effect', () =>
    Effect.gen(function* () {
      const unusable = vi.fn((): never => {
        throw new Error('global fetch must not be used')
      })
      vi.stubGlobal('fetch', unusable)
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json([]))),
      )

      const issues = yield* makeGitHubTracker(provider, client).pipe(
        Effect.flatMap((tracker) => tracker.fetchIssuesByStates(['open'], null)),
      )

      expect(unusable).not.toHaveBeenCalled()
      expect(issues).toEqual([])
    }),
  )
})
