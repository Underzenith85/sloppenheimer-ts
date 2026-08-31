import { Chunk, Duration, Effect, Option, Schedule } from 'effect'

import type { TrackerError } from '../errors.js'

const baseRetryDelayMs = 10_000

/**
 * Agent backoff as a value: ten seconds, doubling for every attempt, capped by workflow config.
 */
export const agentRetrySchedule = (maximumMs: number): Schedule.Schedule<number, number> =>
  Schedule.exponential(baseRetryDelayMs).pipe(
    Schedule.zipWith(Schedule.identity<number>(), (base, attempt) =>
      Math.min(Duration.toMillis(base) * 2 ** Math.max(attempt - 1, 0), maximumMs),
    ),
  )

type TrackerRetryAttempt = Readonly<{
  attempt: number
  error: TrackerError
}>

/**
 * Tracker retry policy. The identity schedule carries the adapter's advertised delay alongside the
 * computed backoff; the union leaves either policy able to contribute, and the mapped output gives
 * an advertised retry-after precedence. Retryability is a recurrence condition of the schedule,
 * rather than a decision repeated by its callers.
 */
export const trackerRetrySchedule = (
  maximumMs: number,
): Schedule.Schedule<Option.Option<number>, TrackerRetryAttempt> =>
  agentRetrySchedule(maximumMs).pipe(
    Schedule.mapInput((input: TrackerRetryAttempt) => input.attempt),
    Schedule.union(
      Schedule.identity<TrackerRetryAttempt>().pipe(
        Schedule.map(({ error }) => ({
          retryable: error.retryable,
          advertised: Option.fromNullable(error.retryAfterMs),
        })),
      ),
    ),
    Schedule.map(([computed, tracker]) =>
      tracker.retryable
        ? tracker.advertised.pipe(Option.orElse(() => Option.some(computed)))
        : Option.none(),
    ),
    Schedule.whileInput(({ error }) => error.retryable),
  )

/** Evaluate the delay for an agent attempt without sleeping. */
export const agentRetryDelay = (attempt: number, maximumMs: number): Effect.Effect<number> =>
  Schedule.run(agentRetrySchedule(maximumMs), 0, [attempt]).pipe(
    Effect.map((delays) => Chunk.last(delays).pipe(Option.getOrElse(() => maximumMs))),
  )

/** Evaluate whether and when a tracker failure should be retried, without sleeping. */
export const trackerRetryDelay = (
  error: TrackerError,
  attempt: number,
  maximumMs: number,
): Effect.Effect<Option.Option<number>> =>
  Schedule.run(trackerRetrySchedule(maximumMs), 0, [{ error, attempt }]).pipe(
    Effect.map((delays) => Chunk.last(delays).pipe(Option.flatten)),
  )

/**
 * Compatibility wrapper for the existing tested public surface. New orchestration code consumes
 * the schedule through `agentRetryDelay` instead.
 */
export const retryDelayMs = (attempt: number, maximumMs: number): number =>
  Effect.runSync(agentRetryDelay(attempt, maximumMs))
