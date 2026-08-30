import { Effect, Exit, Ref, Scope } from 'effect'

/**
 * A port whose instance is not a singleton: it is built from an input that changes during a run —
 * a reloaded workflow, a rotated credential — and rebuilt whenever that input changes.
 *
 * The cell is the wiring that lets one `Context.Tag` stand for such a port. Consumers resolve the
 * tag once and read the current instance through `get`; the reload path calls `rebuild`. A plain
 * `Layer.succeed` of one constructed instance cannot express either half.
 */
export type AdapterCell<Value, Input, BuildError> = Readonly<{
  /** The instance in force now. */
  get: Effect.Effect<Value>
  /**
   * Builds a replacement and installs it. The previous instance is not released here: work already
   * in flight may still hold it, so its release is handed back to the caller as `retirePrevious`.
   */
  rebuild: (input: Input) => Effect.Effect<AdapterRebuild<Value>, BuildError>
}>

export type AdapterRebuild<Value> = Readonly<{
  value: Value
  /**
   * Releases the instance this rebuild replaced. Run it once no in-flight work still holds that
   * instance; it is idempotent, and any instance never retired is released when the cell's scope
   * closes.
   */
  retirePrevious: Effect.Effect<void>
}>

type Held<Value> = Readonly<{
  value: Value
  scope: Scope.CloseableScope
}>

type Cell<Value> = Readonly<{
  current: Held<Value>
  /** Replaced instances whose release the caller has not yet run. */
  retired: readonly Held<Value>[]
}>

const closeHeld = <Value>(held: Held<Value>): Effect.Effect<void> =>
  Scope.close(held.scope, Exit.void)

/**
 * Builds the first instance and returns a cell over it.
 *
 * Every instance is built in its own child scope, so an adapter may acquire resources during
 * construction and have them released when *that* instance is retired, rather than accumulating
 * finalizers on the orchestrator's scope for the life of the process.
 */
export const makeAdapterCell = <Value, Input, BuildError>(
  build: (input: Input) => Effect.Effect<Value, BuildError, Scope.Scope>,
  initial: Input,
): Effect.Effect<AdapterCell<Value, Input, BuildError>, BuildError, Scope.Scope> =>
  Effect.gen(function* () {
    const open = (input: Input): Effect.Effect<Held<Value>, BuildError> =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const value = yield* build(input).pipe(
          Scope.extend(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        return { value, scope }
      })

    const cell = yield* Ref.make<Cell<Value>>({ current: yield* open(initial), retired: [] })
    // One rebuild at a time: two concurrent swaps could otherwise drop an instance without ever
    // releasing it.
    const gate = yield* Effect.makeSemaphore(1)

    yield* Effect.addFinalizer(() =>
      Ref.get(cell).pipe(
        Effect.flatMap((held) =>
          Effect.forEach([held.current, ...held.retired], closeHeld, { discard: true }),
        ),
      ),
    )

    const retire = (held: Held<Value>): Effect.Effect<void> =>
      Ref.modify(cell, (state) => [
        state.retired.includes(held),
        { ...state, retired: state.retired.filter((candidate) => candidate !== held) },
      ]).pipe(Effect.flatMap((present) => (present ? closeHeld(held) : Effect.void)))

    return {
      get: Ref.get(cell).pipe(Effect.map((state) => state.current.value)),
      rebuild: (input) =>
        gate.withPermits(1)(
          open(input).pipe(
            Effect.flatMap((next) =>
              Ref.modify(cell, (state) => [
                state.current,
                { current: next, retired: [...state.retired, state.current] },
              ]).pipe(
                Effect.map((previous) => ({
                  value: next.value,
                  retirePrevious: retire(previous),
                })),
              ),
            ),
          ),
        ),
    }
  })
