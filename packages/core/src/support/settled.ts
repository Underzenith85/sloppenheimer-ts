import { Effect } from 'effect'

/**
 * The outcome of an effect the scheduler runs for its result rather than its success.
 *
 * The event loop has to keep going whatever one step reports: a poll that cannot reach the tracker
 * schedules a retry, a preflight that rejects a credential fails that dispatch alone. Those call
 * sites need the failure as a *value* to branch on, not as a short-circuit — and they need it
 * without leaving `Effect.gen`, because the next thing they do is write state and emit telemetry.
 *
 * This is `Either` under a name the scheduler reads better: `Failed`/`Succeeded` and `error`/`value`
 * say what the branch means where `Left`/`Right` would only say which side it came from.
 */
export type Settled<Value, Failure> =
  | Readonly<{ _tag: 'Succeeded'; value: Value }>
  | Readonly<{ _tag: 'Failed'; error: Failure }>

/**
 * Runs an effect to a {@link Settled}, so its failure becomes a value the caller branches on.
 *
 * The requirements pass through untouched and the result cannot fail, which is what lets a call
 * site `yield*` this inside a loop that must not be interrupted by the step it is observing.
 *
 * Named for what it returns rather than as the verb `settle`, which the scheduler already spends on
 * a run reaching its end and the process adapters on resuming a callback exactly once.
 */
export const asSettled = <Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Settled<Value, Failure>, never, Requirements> =>
  Effect.match(effect, {
    onFailure: (error) => ({ _tag: 'Failed' as const, error }),
    onSuccess: (value) => ({ _tag: 'Succeeded' as const, value }),
  })
