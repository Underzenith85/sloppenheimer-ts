import { it } from '@effect/vitest'
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect'
import { describe, expect } from 'vitest'

import type { ValidatedTrackerProvider } from '@symphony/core/config/workflow.js'
import { TrackerError } from '@symphony/core/domain/errors.js'
import { stubProvider, stubProviderToken } from '../harness/stub-tracker-provider.js'
import {
  CurrentTracker,
  layerCurrentTracker,
  makeAdapterCell,
  tracker,
  TrackerFactory,
  type TrackerPort,
} from '@symphony/core'

const provider = (token: string): ValidatedTrackerProvider => stubProvider(token)

const stubTracker = (validated: ValidatedTrackerProvider): TrackerPort => ({
  fetchIssuesByStates: () => Effect.succeed([]),
  fetchIssuesByIds: () => Effect.succeed([]),
  toolSpecs: [],
  executeTool: () => Promise.resolve({ success: true, data: null }),
  secretEnvironmentNames: [stubProviderToken(validated)],
})

/** Records construction and release so a rebuild's lifecycle is observable. */
const recordingFactory = (built: string[], released: string[]): Layer.Layer<TrackerFactory> =>
  Layer.succeed(TrackerFactory, {
    make: (validated) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          built.push(stubProviderToken(validated))
          return stubTracker(validated)
        }),
        () => Effect.sync(() => released.push(stubProviderToken(validated))),
      ),
  })

const failingFactory = Layer.succeed(TrackerFactory, {
  make: () =>
    Effect.fail(
      new TrackerError({
        category: 'missing_tracker_secret',
        message: 'no credential',
        retryable: false,
      }),
    ),
})

describe('current tracker cell', (): void => {
  it.scoped('serves the instance built from the initial provider', () => {
    const built: string[] = []
    const released: string[] = []

    return Effect.gen(function* () {
      const secrets = yield* tracker.pipe(Effect.map((current) => current.secretEnvironmentNames))

      expect(secrets).toEqual(['first'])
      expect(built).toEqual(['first'])
    }).pipe(
      Effect.provide(
        layerCurrentTracker(provider('first')).pipe(
          Layer.provide(recordingFactory(built, released)),
        ),
      ),
    )
  })

  it.effect(
    'rebuilds on a rotated provider and releases the replaced instance once retired',
    () => {
      const built: string[] = []
      const released: string[] = []

      return Effect.gen(function* () {
        const observed = yield* Effect.gen(function* () {
          const cell = yield* CurrentTracker
          const before = yield* cell.get
          const rebuilt = yield* cell.rebuild(provider('second'))
          const afterSwap = [...released]
          yield* rebuilt.retirePrevious
          // Retirement is idempotent: a caller that retires twice releases once.
          yield* rebuilt.retirePrevious
          const afterRetire = [...released]
          const current = yield* cell.get
          return {
            before: before.secretEnvironmentNames,
            afterSwap,
            afterRetire,
            current: current.secretEnvironmentNames,
            rebuilt: rebuilt.value.secretEnvironmentNames,
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerCurrentTracker(provider('first')).pipe(
              Layer.provide(recordingFactory(built, released)),
            ),
          ),
        )

        expect(observed.before).toEqual(['first'])
        expect(observed.rebuilt).toEqual(['second'])
        expect(observed.current).toEqual(['second'])
        // The replaced instance survives the swap: in-flight work may still hold it.
        expect(observed.afterSwap).toEqual([])
        expect(observed.afterRetire).toEqual(['first'])
        expect(built).toEqual(['first', 'second'])
        // Closing the surrounding scope releases whatever instance was still in force.
        expect(released).toEqual(['first', 'second'])
      })
    },
  )

  it.effect('releases the instance in force when the cell scope closes', () => {
    const built: string[] = []
    const released: string[] = []

    return Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(
        layerCurrentTracker(provider('first')).pipe(
          Layer.provide(recordingFactory(built, released)),
        ),
        scope,
      )
      expect(released).toEqual([])
      yield* Scope.close(scope, yield* Effect.exit(Effect.void))

      expect(built).toEqual(['first'])
      expect(released).toEqual(['first'])
    })
  })

  it.effect('surfaces a construction failure as a layer error', () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(
        Effect.scoped(
          tracker.pipe(
            Effect.provide(
              layerCurrentTracker(provider('first')).pipe(Layer.provide(failingFactory)),
            ),
          ),
        ),
      )

      expect(outcome._tag).toBe('Failure')
    }),
  )

  it.effect('releases an instance built by a rebuild that races the cell shutdown', () => {
    const built: string[] = []
    const released: string[] = []

    return Effect.gen(function* () {
      // The rebuild is held inside construction so that shutdown is forced to interleave with it.
      const blocking = yield* Deferred.make<void>()
      const reached = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const cell = yield* makeAdapterCell((token: string) => {
        const acquire = Effect.acquireRelease(
          Effect.sync(() => {
            built.push(token)
            return token
          }),
          () => Effect.sync(() => released.push(token)),
        )
        return token === 'first'
          ? acquire
          : Deferred.succeed(reached, undefined).pipe(
              Effect.zipRight(Deferred.await(blocking)),
              Effect.zipRight(acquire),
            )
      }, 'first' as string).pipe(Scope.extend(scope))

      const rebuilding = yield* Effect.fork(cell.rebuild('second'))
      yield* Deferred.await(reached)
      const closing = yield* Effect.fork(Scope.close(scope, Exit.void))
      yield* Deferred.succeed(blocking, undefined)
      yield* Fiber.join(rebuilding)
      yield* Fiber.join(closing)

      // A rebuild that begins after shutdown installs nothing at all.
      const late = yield* Effect.exit(cell.rebuild('third'))
      expect(Exit.isInterrupted(late)).toBe(true)

      expect(built).toEqual(['first', 'second'])
      // Neither instance leaks: the replacement installed during shutdown is released too.
      expect([...released].sort()).toEqual(['first', 'second'])
    })
  })
})
