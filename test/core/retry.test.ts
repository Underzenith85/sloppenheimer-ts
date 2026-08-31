import { Chunk, Effect, Option, Schedule } from 'effect'
import { describe, expect, it } from 'vitest'

import { TrackerError } from '../../src/errors.js'
import {
  agentRetrySchedule,
  trackerRetryDelay,
  trackerRetrySchedule,
} from '../../src/core/retry.js'

const trackerError = (retryable = true, retryAfterMs?: number): TrackerError =>
  new TrackerError({
    category: 'tracker_request',
    message: 'tracker failed',
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })

describe('retry schedules', () => {
  it('expresses capped exponential agent backoff as a schedule', async (): Promise<void> => {
    const delays = await Effect.runPromise(
      Effect.forEach([1, 2, 3, 4], (attempt) =>
        Schedule.run(agentRetrySchedule(25_000), 0, [attempt]).pipe(
          Effect.map(Chunk.toReadonlyArray),
          Effect.map(([delay]) => delay),
        ),
      ),
    )

    expect(delays).toEqual([10_000, 20_000, 25_000, 25_000])
  })

  it('gives tracker retry-after precedence over computed backoff', async (): Promise<void> => {
    const delay = await Effect.runPromise(trackerRetryDelay(trackerError(true, 45_000), 2, 300_000))

    expect(delay).toEqual(Option.some(45_000))
  })

  it('rejects non-retryable tracker failures in the schedule policy', async (): Promise<void> => {
    const error = trackerError(false)
    const delay = await Effect.runPromise(trackerRetryDelay(error, 1, 300_000))
    const outputs = await Effect.runPromise(
      Schedule.run(trackerRetrySchedule(300_000), 0, [
        { error, attempt: 1 },
        { error, attempt: 2 },
      ]),
    )

    expect(delay).toEqual(Option.none())
    expect(Chunk.size(outputs)).toBe(1)
  })
})
