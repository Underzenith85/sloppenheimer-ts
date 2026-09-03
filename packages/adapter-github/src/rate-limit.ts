import { Clock, Context, Duration, Effect, Option, Ref } from 'effect'

import { logInfo } from '@sloppenheimer/core/support/logging.js'
import { recordGitHubRateLimitDelay } from './observability.js'
import { githubTrafficKey, type GitHubProviderConfig } from './provider.js'

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
 * Builds a limiter for one provider generation, against the clock it will book its admissions on.
 *
 * This is a plain function rather than an `Effect`, and its state is `unsafeMake`d, because a
 * limiter acquires nothing: there is no fiber, no handle and no socket behind it, so there is
 * nothing for a scope to release and nothing for the runtime to interrupt. That is what lets one
 * limiter be shared by four adapters built into four independent cell scopes — see
 * {@link githubRateLimitFor} — and it is why the pacing is a booked instant rather than a
 * bucket a background fiber refills.
 *
 * `clock` is a parameter rather than a read of whichever clock the calling fiber happens to carry,
 * because a booking is an instant and the fiber is not always the one that constructed the
 * limiter: the host-tool boundary runs its request through `Effect.runPromise`, on a fresh runtime
 * carrying the default clock. Booking that request against a different clock than the last one
 * would leave the bucket holding an instant no reader can interpret — and, where the two clocks
 * are a test clock and the live one, a wait of decades.
 *
 * Admission is the generic cell rate algorithm. `bookedUntil` is the instant the bucket would next
 * be empty; a request may start `toleranceMs` ahead of it, which is what spends the burst
 * allowance, and every admission books one more emission interval. The whole decision is a single
 * atomic `Ref.modify` of a number, so concurrent fibers cannot both read the same slot.
 */
export const makeGitHubRateLimit = (
  clock: Clock.Clock,
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

  /**
   * Books the slot and waits it out, then reports what the whole wait came to — the permit
   * included, which is why `queuedAt` is read before the permit rather than here. Reporting after
   * admission rather than before it costs an operator nothing a metric does not already give them,
   * and it is the only point at which the true wait is known.
   */
  const admit = (queuedAt: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const reservation = yield* reserve
      if (reservation.waitMs > 0) {
        yield* Effect.sleep(Duration.millis(reservation.waitMs)).pipe(
          Effect.onInterrupt(() => surrender(reservation.bookedUntil)),
        )
      }
      const waitedMs = (yield* Clock.currentTimeMillis) - queuedAt
      yield* recordGitHubRateLimitDelay(waitedMs)
      if (waitedMs >= delayLogThresholdMs) {
        yield* logInfo('GitHub requests are waiting on the provider rate limiter', {
          action: 'github_rate_limit',
          outcome: 'delayed',
          provider_scope: providerScope,
          waited_ms: waitedMs,
        })
      }
    }).pipe(Effect.withClock(clock))

  return {
    /**
     * The permit is taken before the slot is booked, so that pacing stays adjacent to issuance.
     * The other order lets a request spend its emission slot and then sit on the semaphore behind
     * a slow holder: by the time the permit frees, its booking is long past, and every request
     * queued that way starts at once — a burst larger than the one the settings describe, made of
     * slots that were paid for minutes earlier. Holding a permit across the wait costs nothing,
     * because a request waiting for capacity is a request that has not been issued either way.
     */
    limit: <Value, Failure, Requirements>(
      request: Effect.Effect<Value, Failure, Requirements>,
    ): Effect.Effect<Value, Failure, Requirements> =>
      Effect.flatMap(clock.currentTimeMillis, (queuedAt: number) =>
        inFlight.withPermits(1)(Effect.zipRight(admit(queuedAt), request)),
      ),
  }
}

/**
 * The limiters in force, one per provider generation, under the clock each books its admissions on.
 *
 * This is process-wide state, and deliberately so. The GitHub capabilities are built into four
 * independent adapter cells, at different instants and into different scopes, and the whole point
 * of the limiter is that all of them pace against one credential: there is no scope that outlives
 * every holder and no parameter every constructor already carries, so the sharing point has to be
 * a registry the generation itself keys. It holds no resource, so it needs no scope of its own.
 *
 * Nothing is evicted, because a count-based bound cannot tell a generation nothing holds from one
 * an in-flight adapter is still pacing against: evicting the latter and then meeting its
 * credential again would build a second limiter beside the first, and the two would spend
 * independent burst allowances against one budget. What is retained instead is made cheap — a
 * digest and a number per generation, and no credential — and the outer map is weak on the clock,
 * so a clock that goes away takes its generations with it.
 */
const generations = new WeakMap<Clock.Clock, Map<string, GitHubRateLimit>>()

/**
 * The limiter for one provider generation, building it on first use.
 *
 * A generation is what shares a budget at GitHub, so `githubTrafficKey` is the key rather than
 * whole-provider equality: a selection is a new object every time — the operator console
 * revalidates the workflow on every request and a reload revalidates it on every file change — and
 * a reload that only moved the base branch would otherwise mint a fresh limiter, and with it a
 * fresh burst allowance, beside the one its predecessor is still spending. A rotated credential is
 * different traffic, so it gets a limiter of its own, and the superseded one stays in force for
 * whatever still holds it: an adapter built from the previous generation keeps pacing against the
 * limiter it was built with until its in-flight work retires it.
 *
 * The clock is the outer key for the same reason it is a parameter to the limiter. A process has
 * one clock, so this changes nothing in production; a test that installs a `TestClock` gets a
 * limiter whose bookings that clock can actually reach, rather than one pinned to a clock that has
 * since gone.
 *
 * The lookup is one synchronous step, which is what makes it atomic: no other fiber runs between
 * finding nothing and installing what it built.
 */
export const githubRateLimitFor = (
  provider: GitHubProviderConfig,
  settings: GitHubRateLimitSettings = githubRateLimitDefaults,
): Effect.Effect<GitHubRateLimit> =>
  Effect.clockWith((clock: Clock.Clock) =>
    Effect.sync(() => {
      const underClock = generations.get(clock) ?? new Map<string, GitHubRateLimit>()
      generations.set(clock, underClock)
      const key = githubTrafficKey(provider)
      const held = underClock.get(key)
      if (held !== undefined) {
        return held
      }
      const opened = makeGitHubRateLimit(clock, provider, settings)
      underClock.set(key, opened)
      return opened
    }),
  )
