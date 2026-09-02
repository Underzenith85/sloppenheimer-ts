import { Effect, Metric } from 'effect'

import { observeDuration, withOperationalSpan } from '@sloppenheimer/core/support/observability.js'

/** Kept in the adapter so core orchestration never names a concrete provider. */
export const githubRequestDuration = Metric.timer(
  'sloppenheimer_github_request_duration',
  'GitHub HTTP request latency.',
)

/**
 * How long a request waited for the provider generation's own capacity before it was issued.
 *
 * It is a metric of its own rather than part of {@link githubRequestDuration} because the two
 * answer different questions: how long GitHub took, and how long this host held the request back.
 * Folding the wait into request latency would make local pacing look like a slow tracker.
 */
export const githubRateLimitDelay = Metric.timer(
  'sloppenheimer_github_rate_limit_delay',
  'Time a GitHub request waited for provider rate-limit capacity before it was issued.',
)

export const observeGitHubRequest =
  (method: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    observeDuration(githubRequestDuration, effect).pipe(
      withOperationalSpan('github.request', { method, provider: 'github' }),
    )

export const observeGitHubRateLimitDelay = <A, E, R>(
  wait: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => observeDuration(githubRateLimitDelay, wait)
