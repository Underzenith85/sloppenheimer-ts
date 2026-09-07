/** A reload owns one child scope. Publication and replacement share one atomic state cell. */
import { Context, Effect, ExecutionStrategy, Exit, Layer, Option, Ref, Scope } from 'effect'
import { decodeRegistry, type RegistryEntry, type RegistryError } from './config.js'

export type EntryStatus = 'not_connected' | 'unavailable'
export type EntryLease = Readonly<{ id: string; generation: number }>
type ActiveRegistry = Readonly<{
  nextGeneration: number
  generation: number
  entries: readonly RegistryEntry[]
  statuses: ReadonlyMap<string, EntryStatus>
  scope: Scope.CloseableScope
}>
export type RegistrySnapshot = Readonly<{
  status: 'empty_registry' | 'configured'
  generation: number
  instances: readonly Readonly<{ id: string; label: string; status: EntryStatus }>[]
}>
export type RegistryService = Readonly<{
  snapshot: Effect.Effect<RegistrySnapshot>
  lease: (id: string) => Effect.Effect<Option.Option<EntryLease>>
  publish: (lease: EntryLease, status: EntryStatus) => Effect.Effect<boolean>
  reload: (input: unknown) => Effect.Effect<void, RegistryError>
}>
export class Registry extends Context.Tag('@sloppenheimer/coordinator/Registry')<
  Registry,
  RegistryService
>() {}
export type PrepareEntry = (
  entry: RegistryEntry,
  lease: EntryLease,
) => Effect.Effect<void, RegistryError, Scope.Scope>

const snapshotOf = (state: ActiveRegistry): RegistrySnapshot => ({
  status: state.entries.length === 0 ? 'empty_registry' : 'configured',
  generation: state.generation,
  instances: state.entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    status: state.statuses.get(entry.id) ?? 'not_connected',
  })),
})

export const makeRegistry = (
  initial: unknown,
  prepare: PrepareEntry = () => Effect.void,
): Effect.Effect<RegistryService, RegistryError, Scope.Scope> =>
  Effect.gen(function* () {
    const owner = yield* Effect.scope
    const initialScope = yield* Scope.fork(owner, ExecutionStrategy.sequential)
    const state = yield* Ref.make<ActiveRegistry>({
      nextGeneration: 1,
      generation: 0,
      entries: [],
      statuses: new Map(),
      scope: initialScope,
    })
    const semaphore = yield* Effect.makeSemaphore(1)
    const reload = (input: unknown): Effect.Effect<void, RegistryError> =>
      semaphore.withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const entries = yield* restore(decodeRegistry(input))
            // Even a failed preparation consumes its generation: a retired staged callback must
            // never acquire the identity of a later successful replacement.
            const generation = yield* Ref.modify(state, (current) => [
              current.nextGeneration,
              { ...current, nextGeneration: current.nextGeneration + 1 },
            ])
            const scope = yield* Scope.fork(owner, ExecutionStrategy.sequential)
            const prepared = yield* restore(
              Effect.forEach(entries, (entry) => prepare(entry, { id: entry.id, generation }), {
                discard: true,
              }).pipe(Effect.provideService(Scope.Scope, scope)),
            ).pipe(Effect.exit)
            if (Exit.isFailure(prepared)) {
              yield* Scope.close(scope, prepared)
              return yield* Effect.failCause(prepared.cause)
            }
            const retiredScope = yield* Ref.modify(state, (current) => [
              current.scope,
              { ...current, generation, entries, statuses: new Map(), scope },
            ])
            // The old generation is fenced before its finalizers run, including callbacks from cleanup.
            yield* Scope.close(retiredScope, Exit.void)
          }),
        ),
      )
    yield* reload(initial)
    return {
      reload,
      snapshot: Effect.map(Ref.get(state), snapshotOf),
      lease: (id) =>
        Effect.map(Ref.get(state), (current) =>
          current.entries.some((entry) => entry.id === id)
            ? Option.some({ id, generation: current.generation })
            : Option.none(),
        ),
      publish: (lease, status) =>
        Ref.modify(state, (current) => {
          if (
            current.generation !== lease.generation ||
            !current.entries.some((entry) => entry.id === lease.id)
          ) {
            return [false, current]
          }
          const statuses = new Map(current.statuses)
          statuses.set(lease.id, status)
          return [true, { ...current, statuses }]
        }),
    }
  })

export const registryLayer = (input: unknown): Layer.Layer<Registry, RegistryError> =>
  Layer.scoped(Registry, makeRegistry(input))
