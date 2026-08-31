import * as HttpClient from '@effect/platform/HttpClient'
import * as HttpClientError from '@effect/platform/HttpClientError'
import type * as HttpClientRequest from '@effect/platform/HttpClientRequest'
import * as HttpClientResponse from '@effect/platform/HttpClientResponse'
import { Effect, Fiber, Layer, Redacted, TestClock, TestContext } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { githubJson, type GitHubHttpResult } from '../../../src/adapters/github/client.js'
import { makeGitHubTracker } from '../../../src/adapters/github/issues.js'
import { issueId, issueIdentifier } from '../../../src/domain/domain.js'
import type { GitHubProviderConfig } from '../../../src/adapters/github/index.js'
import type { TrackerError } from '../../../src/errors.js'

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'symphony',
  token: Redacted.make('secret'),
  tokenEnvironmentName: 'GITHUB_TOKEN',
  apiBaseUrl: 'https://api.example.test',
  baseBranch: 'main',
}

const issuesUrl = 'https://api.example.test/repos/example/symphony/issues'

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

const run = (
  effect: Effect.Effect<GitHubHttpResult, TrackerError>,
  layer: Layer.Layer<HttpClient.HttpClient>,
): Promise<GitHubHttpResult> => Effect.runPromise(effect.pipe(Effect.provide(layer)))

const runFailure = (
  effect: Effect.Effect<GitHubHttpResult, TrackerError>,
  layer: Layer.Layer<HttpClient.HttpClient>,
): Promise<TrackerError> => Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(layer)))

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('GitHub transport client injection', (): void => {
  it('sends every request through the provided client rather than global fetch', async (): Promise<void> => {
    const unusable = vi.fn((): never => {
      throw new Error('global fetch must not be used')
    })
    vi.stubGlobal('fetch', unusable)
    const requests: HttpClientRequest.HttpClientRequest[] = []

    const result = await run(
      githubJson(provider, issuesUrl),
      clientLayer((request) => {
        requests.push(request)
        return Response.json([], { headers: { Link: `<${issuesUrl}?page=2>; rel="next"` } })
      }),
    )

    expect(unusable).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
    expect(result).toEqual({
      status: 200,
      body: [],
      linkHeader: `<${issuesUrl}?page=2>; rel="next"`,
    })
  })

  it('applies the GitHub authentication, agent, and API version headers', async (): Promise<void> => {
    const observed: HttpClientRequest.HttpClientRequest[] = []

    await run(
      githubJson(provider, issuesUrl),
      clientLayer((request) => {
        observed.push(request)
        return Response.json([])
      }),
    )

    expect(observed[0]?.headers).toMatchObject({
      accept: 'application/vnd.github+json',
      authorization: 'Bearer secret',
      'user-agent': 'symphony-ts/0.1',
      'x-github-api-version': '2026-03-10',
    })
    expect(observed[0]?.headers['content-type']).toBeUndefined()
  })

  it('declares a JSON content type only for a request that carries a body', async (): Promise<void> => {
    const observed: HttpClientRequest.HttpClientRequest[] = []

    await run(
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
  })
})

describe('GitHub transport error mapping', (): void => {
  it('maps a secondary rate limit onto its advertised delay', async (): Promise<void> => {
    const error = await runFailure(
      githubJson(provider, issuesUrl),
      clientLayer(() => new Response(null, { status: 429, headers: { 'Retry-After': '30' } })),
    )

    expect(error.category).toBe('tracker_rate_limited')
    expect(error.retryable).toBe(true)
    expect(error.retryAfterMs).toBe(30_000)
  })

  it('maps an exhausted primary rate limit onto its reset window', async (): Promise<void> => {
    const reset = Math.floor(Date.now() / 1_000) + 120

    const error = await runFailure(
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
    expect(error.retryAfterMs).toBeGreaterThan(0)
  })

  it('keeps server statuses retryable and client statuses terminal', async (): Promise<void> => {
    const serverError = await runFailure(
      githubJson(provider, issuesUrl),
      clientLayer(() => new Response(null, { status: 502 })),
    )
    const clientError = await runFailure(
      githubJson(provider, issuesUrl),
      clientLayer(() => new Response(null, { status: 404 })),
    )

    expect(serverError.category).toBe('tracker_status')
    expect(serverError.retryable).toBe(true)
    expect(clientError.category).toBe('tracker_status')
    expect(clientError.message).toBe('GitHub returned HTTP 404')
    expect(clientError.retryable).toBe(false)
  })

  it('returns an accepted non-success status without decoding its body', async (): Promise<void> => {
    const result = await run(
      githubJson(provider, `${issuesUrl}/1/labels/bug`, { method: 'DELETE' }, [404]),
      clientLayer(() => new Response('not json', { status: 404 })),
    )

    expect(result).toEqual({ status: 404, body: null, linkHeader: null })
  })

  it('returns an empty body for a no-content response', async (): Promise<void> => {
    const result = await run(
      githubJson(provider, `${issuesUrl}/1`, { method: 'PATCH', body: '{}' }),
      clientLayer(() => new Response(null, { status: 204 })),
    )

    expect(result).toEqual({ status: 204, body: null, linkHeader: null })
  })

  it('rejects a malformed JSON payload as a response failure', async (): Promise<void> => {
    const error = await runFailure(
      githubJson(provider, issuesUrl),
      clientLayer(
        () => new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
      ),
    )

    expect(error.category).toBe('tracker_response')
    expect(error.retryable).toBe(false)
  })

  it('reports a transport failure as retryable', async (): Promise<void> => {
    const error = await runFailure(
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
  })

  it('fails a request that outlives the transport deadline', async (): Promise<void> => {
    const error = await Effect.runPromise(
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
        return yield* Fiber.join(attempt)
      }).pipe(Effect.provide(TestContext.TestContext)),
    )

    expect(error.category).toBe('tracker_request')
    expect(error.retryable).toBe(true)
  })
})

describe('GitHub adapter client binding', (): void => {
  it('runs promise-shaped tool requests through the bound client', async (): Promise<void> => {
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

    const result = await Effect.runSync(makeGitHubTracker(provider, client)).executeTool(
      'github_add_comment',
      { body: 'hello' },
      {
        issueId: issueId('7'),
        issueIdentifier: issueIdentifier('example/symphony#7'),
        nativeRef: { owner: 'example', repository: 'symphony', issue_number: 7 },
      },
    )

    expect(unusable).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: true,
      data: { issue_number: 7, comment_url: 'https://example.test/comment/1' },
    })
    expect(requests[0]?.url).toBe(
      'https://api.example.test/repos/example/symphony/issues/7/comments',
    )
  })

  it('binds the same client to the operations that stay in Effect', async (): Promise<void> => {
    const unusable = vi.fn((): never => {
      throw new Error('global fetch must not be used')
    })
    vi.stubGlobal('fetch', unusable)
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json([]))),
    )

    const issues = await Effect.runPromise(
      Effect.runSync(makeGitHubTracker(provider, client)).fetchIssuesByStates(['open'], null),
    )

    expect(unusable).not.toHaveBeenCalled()
    expect(issues).toEqual([])
  })
})
