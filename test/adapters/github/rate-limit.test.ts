import * as HttpClient from '@effect/platform/HttpClient'
import type * as HttpClientRequest from '@effect/platform/HttpClientRequest'
import * as HttpClientResponse from '@effect/platform/HttpClientResponse'
import { it } from '@effect/vitest'
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Logger,
  Metric,
  Option,
  Redacted,
  TestClock,
} from 'effect'
import { describe, expect } from 'vitest'

import { githubJson, githubTransportFor } from '@sloppenheimer/adapter-github/client.js'
import { makeGitHubCodeReview } from '@sloppenheimer/adapter-github/code-review.js'
import { makeGitHubTracker } from '@sloppenheimer/adapter-github/issues.js'
import { githubRateLimitDelay } from '@sloppenheimer/adapter-github/observability.js'
import {
  githubRateLimitDefaults,
  githubRateLimitFor,
  makeGitHubRateLimit,
  type GitHubRateLimitSettings,
} from '@sloppenheimer/adapter-github/rate-limit.js'
import type { GitHubProviderConfig } from '@sloppenheimer/adapter-github'

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'sloppenheimer',
  token: Redacted.make('secret'),
  tokenEnvironmentName: 'GITHUB_TOKEN',
  apiBaseUrl: 'https://api.example.test',
  baseBranch: 'main',
}

/** Two admissions immediately, then one every 500ms. */
const pacedSettings: GitHubRateLimitSettings = {
  requestsPerInterval: 2,
  intervalMs: 1_000,
  concurrency: 4,
}

/** One admission every second, and one request in flight at a time. */
const strictSettings: GitHubRateLimitSettings = {
  requestsPerInterval: 1,
  intervalMs: 1_000,
  concurrency: 1,
}

const rotated: GitHubProviderConfig = { ...provider, token: Redacted.make('rotated') }

const stubClient = (
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, respond(request))),
  )

describe('GitHub transport pacing', (): void => {
  it.effect('spends the burst allowance, then admits one request per emission interval', () =>
    Effect.gen(function* () {
      const limiter = makeGitHubRateLimit(provider, pacedSettings)
      const admitted = (): Effect.Effect<number> => limiter.limit(Clock.currentTimeMillis)

      expect(yield* admitted()).toBe(0)
      expect(yield* admitted()).toBe(0)

      const third = yield* Effect.fork(admitted())
      yield* TestClock.adjust(Duration.millis(499))
      expect(Option.isNone(yield* Fiber.poll(third))).toBe(true)

      yield* TestClock.adjust(Duration.millis(1))
      expect(yield* Fiber.join(third)).toBe(500)

      const fourth = yield* Effect.fork(admitted())
      yield* TestClock.adjust(Duration.millis(500))
      expect(yield* Fiber.join(fourth)).toBe(1_000)
    }),
  )

  it.effect('bounds how many admitted requests run at once', () =>
    Effect.gen(function* () {
      const limiter = makeGitHubRateLimit(provider, {
        requestsPerInterval: 10,
        intervalMs: 1_000,
        concurrency: 1,
      })
      const request = limiter.limit(
        Effect.sleep(Duration.millis(100)).pipe(Effect.zipRight(Clock.currentTimeMillis)),
      )

      const both = yield* Effect.fork(Effect.all([request, request], { concurrency: 2 }))
      yield* TestClock.adjust(Duration.millis(200))

      expect(yield* Fiber.join(both)).toEqual([100, 200])
    }),
  )

  it.effect('records the wait as its own metric rather than as GitHub latency', () =>
    Effect.gen(function* () {
      const limiter = makeGitHubRateLimit(provider, pacedSettings)
      const before = (yield* Metric.value(githubRateLimitDelay)).count

      yield* limiter.limit(Effect.void)
      const waited = yield* Effect.fork(limiter.limit(Effect.void))
      yield* TestClock.adjust(Duration.millis(1_000))
      yield* Fiber.join(waited)

      expect((yield* Metric.value(githubRateLimitDelay)).count).toBe(before + 2)
    }),
  )
})

describe('GitHub transport pacing visibility', (): void => {
  const captured = <Value>(
    effect: Effect.Effect<Value>,
  ): Effect.Effect<Readonly<{ value: Value; logs: readonly string[] }>> => {
    const logs: string[] = []
    return effect
      .pipe(
        Effect.provide(
          Logger.replace(
            Logger.defaultLogger,
            Logger.make(({ message }: Readonly<{ message: unknown }>) => {
              logs.push(JSON.stringify(message))
            }),
          ),
        ),
      )
      .pipe(Effect.map((value) => ({ value, logs })))
  }

  it.effect('reports a throttled request by provider scope and never by credential', () =>
    Effect.gen(function* () {
      const limiter = makeGitHubRateLimit(provider, strictSettings)
      yield* limiter.limit(Effect.void)

      const throttled = yield* Effect.fork(captured(limiter.limit(Effect.void)))
      yield* TestClock.adjust(Duration.millis(1_000))
      const { logs } = yield* Fiber.join(throttled)

      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('paced by the provider rate limiter')
      expect(logs[0]).toContain('example/sloppenheimer')
      expect(logs[0]).toContain('1000')
      expect(logs.join('')).not.toContain('secret')
    }),
  )
})

describe('GitHub transport pacing interruption', (): void => {
  it.effect('gives an interrupted wait its emission slot back', () =>
    Effect.gen(function* () {
      const limiter = makeGitHubRateLimit(provider, strictSettings)
      yield* limiter.limit(Effect.void)

      const abandoned = yield* Effect.fork(limiter.limit(Effect.void))
      yield* TestClock.adjust(Duration.millis(1))
      yield* Fiber.interrupt(abandoned)

      // Without the surrender this would be booked behind the abandoned request, at 2,000ms.
      const next = yield* Effect.fork(limiter.limit(Clock.currentTimeMillis))
      yield* TestClock.adjust(Duration.millis(999))

      expect(yield* Fiber.join(next)).toBe(1_000)
    }),
  )

  it.effect('releases the in-flight permit an interrupted waiter was queued for', () =>
    Effect.gen(function* () {
      const limiter = makeGitHubRateLimit(provider, {
        requestsPerInterval: 100,
        intervalMs: 1_000,
        concurrency: 1,
      })
      const held = yield* Deferred.make<void>()
      const holder = yield* Effect.fork(limiter.limit(Deferred.await(held)))
      yield* TestClock.adjust(Duration.zero)

      const waiter = yield* Effect.fork(limiter.limit(Effect.void))
      yield* TestClock.adjust(Duration.zero)
      yield* Fiber.interrupt(waiter)

      yield* Deferred.succeed(held, undefined)
      yield* Fiber.join(holder)

      const after = yield* Effect.fork(limiter.limit(Effect.succeed('admitted')))
      yield* TestClock.adjust(Duration.zero)
      expect(yield* Fiber.join(after)).toBe('admitted')
    }),
  )
})

describe('GitHub provider generations', (): void => {
  it.effect('answers with one limiter for a provider that has not changed', () =>
    Effect.gen(function* () {
      const built = yield* githubRateLimitFor(provider)

      // A reload revalidates the same selection into a new record; it is the same generation.
      expect(yield* githubRateLimitFor({ ...provider, token: Redacted.make('secret') })).toBe(built)
    }),
  )

  it.effect('gives a rotated credential and an unrelated repository limiters of their own', () =>
    Effect.gen(function* () {
      const built = yield* githubRateLimitFor(provider)

      expect(yield* githubRateLimitFor(rotated)).not.toBe(built)
      expect(yield* githubRateLimitFor({ ...provider, repository: 'other' })).not.toBe(built)
      expect(yield* githubRateLimitFor(provider)).toBe(built)
    }),
  )

  it.effect('does not pace one generation against another, nor one provider against another', () =>
    Effect.gen(function* () {
      const spent = yield* githubRateLimitFor(provider, strictSettings)
      yield* spent.limit(Effect.void)

      // Both are unspent, so neither waits on the budget the first generation exhausted.
      const successor = yield* githubRateLimitFor(rotated, strictSettings)
      const unrelated = yield* githubRateLimitFor({ ...provider, owner: 'other' }, strictSettings)
      expect(yield* successor.limit(Clock.currentTimeMillis)).toBe(0)
      expect(yield* unrelated.limit(Clock.currentTimeMillis)).toBe(0)

      // The superseded generation still paces whatever still holds it.
      const behind = yield* Effect.fork(spent.limit(Clock.currentTimeMillis))
      yield* TestClock.adjust(Duration.millis(1_000))
      expect(yield* Fiber.join(behind)).toBe(1_000)
    }),
  )
})

describe('GitHub capability pacing', (): void => {
  /**
   * Occupies every in-flight permit of the generation's limiter, so that a request which reached
   * the transport through that limiter cannot start until one is released.
   */
  const saturate = (released: Deferred.Deferred<void>): Effect.Effect<Fiber.RuntimeFiber<void>> =>
    Effect.flatMap(githubRateLimitFor(provider), (limiter) =>
      Effect.fork(
        Effect.all(
          Array.from({ length: githubRateLimitDefaults.concurrency }, () =>
            limiter.limit(Deferred.await(released)),
          ),
          { concurrency: 'unbounded', discard: true },
        ),
      ),
    )

  it.effect('holds a tracker read behind the generation limiter it shares', () =>
    Effect.gen(function* () {
      const requests: HttpClientRequest.HttpClientRequest[] = []
      const tracker = yield* makeGitHubTracker(
        provider,
        stubClient((request) => {
          requests.push(request)
          return Response.json([])
        }),
      )
      const released = yield* Deferred.make<void>()
      const saturated = yield* saturate(released)
      yield* TestClock.adjust(Duration.zero)

      const read = yield* Effect.fork(tracker.fetchIssuesByStates(['open'], null))
      yield* TestClock.adjust(Duration.zero)
      expect(requests).toHaveLength(0)

      yield* Deferred.succeed(released, undefined)
      yield* Fiber.join(saturated)
      expect(yield* Fiber.join(read)).toEqual([])
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect('holds a code-review read behind the same generation limiter', () =>
    Effect.gen(function* () {
      const requests: HttpClientRequest.HttpClientRequest[] = []
      const codeReview = yield* makeGitHubCodeReview(
        provider,
        stubClient((request) => {
          requests.push(request)
          return Response.json({ state: 'closed', merged: false })
        }),
      )
      const released = yield* Deferred.make<void>()
      const saturated = yield* saturate(released)
      yield* TestClock.adjust(Duration.zero)

      const inspection = yield* Effect.fork(codeReview.inspectPullRequest(44))
      yield* TestClock.adjust(Duration.zero)
      expect(requests).toHaveLength(0)

      yield* Deferred.succeed(released, undefined)
      yield* Fiber.join(saturated)
      expect(yield* Fiber.join(inspection)).toMatchObject({ number: 44, merged: false })
      expect(requests).toHaveLength(1)
    }),
  )
})

describe('GitHub rate-limit rejection handling', (): void => {
  it.effect("keeps GitHub's advertised delay authoritative for a request it did reject", () =>
    Effect.gen(function* () {
      const bindTransport = yield* githubTransportFor(
        provider,
        stubClient(() => new Response(null, { status: 429, headers: { 'Retry-After': '30' } })),
      )

      const error = yield* Effect.flip(
        bindTransport(githubJson(provider, `${provider.apiBaseUrl}/rate_limit`)),
      )

      expect(error).toMatchObject({
        category: 'tracker_rate_limited',
        retryable: true,
        retryAfterMs: 30_000,
      })
    }),
  )
})
