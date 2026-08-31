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
      Schedule.run(agentRetrySchedule(25_000), 0, [undefined, undefined, undefined, undefined]),
    )

    expect(Chunk.toReadonlyArray(delays)).toEqual([10_000, 20_000, 25_000, 25_000])
  })

  it('gives tracker retry-after precedence over computed backoff', async (): Promise<void> => {
    const delay = await Effect.runPromise(trackerRetryDelay(trackerError(true, 45_000), 2, 300_000))

    expect(delay).toEqual(Option.some(45_000))
  })

  it('rejects non-retryable tracker failures in the schedule policy', async (): Promise<void> => {
    const error = trackerError(false)
    const delay = await Effect.runPromise(trackerRetryDelay(error, 1, 300_000))
    const outputs = await Effect.runPromise(
      Schedule.run(trackerRetrySchedule(300_000), 0, [error, error]),
    )

    expect(delay).toEqual(Option.none())
    expect(Chunk.size(outputs)).toBe(1)
  })
})
