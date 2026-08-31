import { Clock, Effect } from 'effect'

/**
 * The current instant, read through the Effect clock rather than the ambient one.
 *
 * Every time an effect uses as a scheduling input, a comparison, or a recorded observation comes
 * from here, so a test drives the whole orchestrator from `TestClock` — the same clock `Effect.sleep`
 * and `Schedule` already run against — instead of waiting on the wall clock. `Date` remains the
 * carried representation: the state, telemetry, and wire records are all dated with it, and this
 * only changes where the instant is read.
 *
 * Pure functions keep taking the instant as a parameter; their callers read it here first.
 */
export const currentInstant: Effect.Effect<Date> = Effect.map(
  Clock.currentTimeMillis,
  (millis) => new Date(millis),
)
