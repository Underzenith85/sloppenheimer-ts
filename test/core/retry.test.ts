import { it } from '@effect/vitest'
import { Chunk, Effect, Option, Schedule } from 'effect'
import { describe, expect } from 'vitest'

import { TrackerError } from '@sloppenheimer/core/domain/errors.js'
import {
  agentRetryDelay,
  agentRetrySchedule,
  trackerRetryDelay,
  trackerRetrySchedule,
} from '@sloppenheimer/core/core/retry.js'

const trackerError = (retryable = true, retryAfterMs?: number): TrackerError =>
  new TrackerError({
    category: 'tracker_request',
    message: 'tracker failed',
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })

describe('retry schedules', () => {
  it.effect('expresses capped exponential agent backoff as a schedule', () =>
    Effect.gen(function* () {
      const delays = yield* Schedule.run(agentRetrySchedule(25_000), 0, [1, 2, 3, 4])

      expect(Chunk.toReadonlyArray(delays)).toEqual([10_000, 20_000, 25_000, 25_000])
    }),
  )

  it.effect('evaluates one agent attempt against the same capped policy', () =>
    Effect.gen(function* () {
      expect(yield* agentRetryDelay(1, 300_000)).toBe(10_000)
      expect(yield* agentRetryDelay(3, 300_000)).toBe(40_000)
      expect(yield* agentRetryDelay(99, 300_000)).toBe(300_000)
    }),
  )

  it.effect('gives tracker retry-after precedence over computed backoff', () =>
    Effect.gen(function* () {
      const delay = yield* trackerRetryDelay(trackerError(true, 45_000), 2, 300_000)

      expect(delay).toEqual(Option.some(45_000))
    }),
  )

  it.effect('rejects non-retryable tracker failures in the schedule policy', () =>
    Effect.gen(function* () {
      const error = trackerError(false)
      const delay = yield* trackerRetryDelay(error, 1, 300_000)
      const outputs = yield* Schedule.run(trackerRetrySchedule(300_000), 0, [
        { error, attempt: 1 },
        { error, attempt: 2 },
      ])

      expect(delay).toEqual(Option.none())
      expect(Chunk.size(outputs)).toBe(1)
    }),
  )
})
