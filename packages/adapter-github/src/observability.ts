import { Metric } from 'effect'

import { observeDuration, withOperationalSpan } from '@sloppenheimer/core/support/observability.js'

/** Kept in the adapter so core orchestration never names a concrete provider. */
export const githubRequestDuration = Metric.timer(
  'sloppenheimer_github_request_duration',
  'GitHub HTTP request latency.',
)

export const observeGitHubRequest =
  (method: string) =>
  <A, E, R>(
    effect: import('effect').Effect.Effect<A, E, R>,
  ): import('effect').Effect.Effect<A, E, R> =>
    observeDuration(githubRequestDuration, effect).pipe(
      withOperationalSpan('github.request', { method, provider: 'github' }),
    )
