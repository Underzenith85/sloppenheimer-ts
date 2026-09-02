import { Clock, Context, Duration, Effect, Option, Ref } from 'effect'

import { logInfo } from '@sloppenheimer/core/support/logging.js'
import { observeGitHubRateLimitDelay } from './observability.js'
import { sameGitHubProvider, type GitHubProviderConfig } from './provider.js'

/*
 * Provider-scoped rate limiting for the GitHub transport.
 *
 * Mapping GitHub's own rejections onto retryable errors only reacts after a request has already
 * been refused. Concurrent agents, host tools, reconciliation and handoff inspection all talk to
 * one credential, so the bursts they make together are what a limiter has to bound — before the
 * request rather than after it. `Retry-After` and `X-RateLimit-Reset` stay authoritative for what
 * GitHub did reject; this is the pacing that keeps the host from asking in the first place.
 */

export type GitHubRateLimitSettings = Readonly<{
  /** Requests admitted per `intervalMs` once the burst allowance is spent. */
  requestsPerInterval: number
  intervalMs: number
  /** Requests allowed to be in flight at once. */
  concurrency: number
}>

/**
 * Conservative by design, and fixed rather than configurable: a workflow that could raise these
 * would be a workflow that could exhaust the credential every other host shares.
 *
 * A personal or installation token is allowed 5,000 REST requests an hour. 120 requests per 90
 * seconds sustains one every 750ms — 4,800 an hour — which leaves headroom for whatever
 * else uses the same credential.
 *
 * The burst is what those 120 buy, and it is deliberately larger than the transport's
 * `githubMaxPages`: a single scoped list read may walk 100 pages, and a limiter that throttled one
 * read against itself would be pacing the host's own sequential work rather than the bursts several
 * agents make at once. GitHub's secondary limits refuse more than 100 concurrent requests; 8 stays
 * far clear of that while still overlapping the reads the tracker issues at concurrency 4.
 */
export const githubRateLimitDefaults: GitHubRateLimitSettings = Object.freeze({
  requestsPerInterval: 120,
  intervalMs: 90_000,
  concurrency: 8,
})

/** Below this a wait is ordinary pacing; past it an operator wants to know the host holds back. */
const delayLogThresholdMs = 1_000

/**
 * How many provider generations the registry keeps.
 *
 * Eviction cannot disturb an adapter still running against an evicted generation: a constructed
 * adapter holds its limiter, not a lookup. The bound is only what keeps a host that rotates
 * credentials for weeks from accumulating one entry per rotation.
 */
const retainedGenerations = 4

/** One generation's admission control: it paces starts and bounds how many requests run at once. */
export type GitHubRateLimit = Readonly<{
  limit: <Value, Failure, Requirements>(
    request: Effect.Effect<Value, Failure, Requirements>,
  ) => Effect.Effect<Value, Failure, Requirements>
}>

/**
 * The limiter the transport paces against, read as an optional service exactly as the HTTP client
 * is. An adapter binds its generation's limiter around every operation it exposes; a `githubJson`
 * reached without one — a direct transport test — is unpaced.
 */
export class CurrentGitHubRateLimit extends Context.Tag(
  'sloppenheimer/adapter-github/CurrentGitHubRateLimit',
)<CurrentGitHubRateLimit, GitHubRateLimit>() {}

/** Applies the limiter the caller bound, if it bound one. */
export const withGitHubRateLimit = <Value, Failure, Requirements>(
  request: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, Failure, Requirements> =>
  Effect.flatMap(Effect.serviceOption(CurrentGitHubRateLimit), (bound) =>
    Option.match(bound, { onNone: () => request, onSome: (limit) => limit.limit(request) }),
  )

type Reservation = Readonly<{
  /** How long the caller must wait before its request may start. */
  waitMs: number
  /** The bucket instant this reservation booked, which is what a surrender gives back. */
  bookedUntil: number
}>

/**
 * Builds a limiter for one provider generation.
 *
 * This is a plain function rather than an `Effect`, and its state is `unsafeMake`d, because a
 * limiter acquires nothing: there is no fiber, no handle and no socket behind it, so there is
 * nothing for a scope to release and nothing for the runtime to interrupt. That is what lets one
 * limiter be shared by four adapters built into four independent cell scopes — see
 * {@link githubRateLimitFor} — and it is why the pacing is a booked instant rather than a
 * bucket a background fiber refills.
 *
 * Admission is the generic cell rate algorithm. `bookedUntil` is the instant the bucket would next
 * be empty; a request may start `toleranceMs` ahead of it, which is what spends the burst
 * allowance, and every admission books one more emission interval. The whole decision is a single
 * atomic `Ref.modify` of a number, so concurrent fibers cannot both read the same slot.
 */
export const makeGitHubRateLimit = (
  provider: GitHubProviderConfig,
  settings: GitHubRateLimitSettings = githubRateLimitDefaults,
): GitHubRateLimit => {
  const emissionMs = settings.intervalMs / settings.requestsPerInterval
  const toleranceMs = emissionMs * (settings.requestsPerInterval - 1)
  const providerScope = `${provider.owner}/${provider.repository}`
  const inFlight = Effect.unsafeMakeSemaphore(settings.concurrency)
  const bookedUntil = Ref.unsafeMake(0)

  const reserve: Effect.Effect<Reservation> = Effect.flatMap(
    Clock.currentTimeMillis,
    (now: number) =>
      Ref.modify(bookedUntil, (booked: number): readonly [Reservation, number] => {
        const admittedAt = Math.max(booked, now)
        const booking = admittedAt + emissionMs
        return [{ waitMs: Math.max(0, booked - toleranceMs - now), bookedUntil: booking }, booking]
      }),
  )

  /**
   * Gives a reservation back when its wait was interrupted. Only the last booking may be undone:
   * a later reservation has already been handed out against this one, and rolling back underneath
   * it would admit two requests into the same slot. Anything else forfeits its slot, which errs
   * towards asking GitHub for less.
   */
  const surrender = (booking: number): Effect.Effect<void> =>
    Ref.update(bookedUntil, (booked: number) => (booked === booking ? booked - emissionMs : booked))

  const admit: Effect.Effect<void> = Effect.gen(function* () {
    const reservation = yield* reserve
    if (reservation.waitMs === 0) {
      return
    }
    if (reservation.waitMs >= delayLogThresholdMs) {
      yield* logInfo('GitHub requests are being paced by the provider rate limiter', {
        action: 'github_rate_limit',
        outcome: 'delayed',
        provider_scope: providerScope,
        waited_ms: reservation.waitMs,
      })
    }
    yield* Effect.sleep(Duration.millis(reservation.waitMs)).pipe(
      Effect.onInterrupt(() => surrender(reservation.bookedUntil)),
    )
  }).pipe(observeGitHubRateLimitDelay)

  return {
    limit: <Value, Failure, Requirements>(
      request: Effect.Effect<Value, Failure, Requirements>,
    ): Effect.Effect<Value, Failure, Requirements> =>
      Effect.zipRight(admit, inFlight.withPermits(1)(request)),
  }
}

type Generation = Readonly<{
  /**
   * The clock the limiter's bookings were made against. A booking is an instant, so it means
   * nothing measured against a different clock: a test that installs its own would otherwise
   * inherit a bucket booked minutes into a future its clock has never reached.
   */
  clock: Clock.Clock
  provider: GitHubProviderConfig
  limit: GitHubRateLimit
}>

/**
 * The limiters in force, one per provider generation.
 *
 * This is process-wide state, and deliberately so. The GitHub capabilities are built into four
 * independent adapter cells, at different instants and into different scopes, and the whole point
 * of the limiter is that all of them pace against one credential: there is no scope that outlives
 * every holder and no parameter every constructor already carries, so the sharing point has to be
 * a registry the generation itself keys. It holds no resource, so it needs no scope of its own.
 */
const generations = Ref.unsafeMake<readonly Generation[]>([])

/**
 * The limiter for one provider generation, building it on first use.
 *
 * Generations are matched by value rather than by identity because a validated selection is a new
 * object every time: the operator console revalidates the workflow on every request and a reload
 * revalidates it on every file change, and an identity key would mint a fresh limiter — and with
 * it a fresh burst allowance — for a credential that had not changed. A rotation does not match,
 * so it gets a limiter of its own, and the superseded one stays in force for whatever still holds
 * it: an adapter built from the previous generation keeps pacing against the limiter it was built
 * with until its in-flight work retires it.
 *
 * The clock the calling fiber reads is part of the key for the same reason a booking is an instant
 * rather than a countdown. A process has one clock, so this changes nothing in production; a test
 * that installs a `TestClock` gets a limiter whose bookings that clock can actually reach.
 */
export const githubRateLimitFor = (
  provider: GitHubProviderConfig,
  settings: GitHubRateLimitSettings = githubRateLimitDefaults,
): Effect.Effect<GitHubRateLimit> =>
  Effect.clockWith((clock: Clock.Clock) =>
    Ref.modify(
      generations,
      (current: readonly Generation[]): readonly [GitHubRateLimit, readonly Generation[]] => {
        const held = current.find(
          (generation) =>
            generation.clock === clock && sameGitHubProvider(generation.provider, provider),
        )
        if (held !== undefined) {
          return [held.limit, current]
        }
        const opened: Generation = {
          clock,
          provider,
          limit: makeGitHubRateLimit(provider, settings),
        }
        return [opened.limit, [opened, ...current].slice(0, retainedGenerations)]
      },
    ),
  )
