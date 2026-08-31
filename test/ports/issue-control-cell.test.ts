import { it } from '@effect/vitest'
import { Effect, Fiber, TestClock } from 'effect'
import { describe, expect } from 'vitest'

import type { ValidatedTrackerProvider } from '@symphony/core/config/workflow.js'
import type { TrackerError } from '@symphony/core/domain/errors.js'
import {
  CurrentIssueControl,
  issueControlFor,
  layerCurrentIssueControl,
  layerIssueControlFactory,
  type IssueControlFactoryPort,
  type IssueControlPort,
} from '@symphony/core'
import { stubProvider, stubProviderToken } from '../harness/stub-tracker-provider.js'

const provider = (token: string): ValidatedTrackerProvider => stubProvider(token)

const stub: IssueControlPort = {
  listOpenIssues: () => Effect.succeed([]),
  addLabel: () => Effect.void,
}

/** Provides the cell and its factory once, so a test states only the program it cares about. */
const withCell = <Value>(
  factory: IssueControlFactoryPort,
  program: Effect.Effect<Value, TrackerError, CurrentIssueControl>,
): Effect.Effect<Value, TrackerError> =>
  program.pipe(
    Effect.provide(layerCurrentIssueControl),
    Effect.provide(layerIssueControlFactory(factory)),
  )

describe('issue-control cell', (): void => {
  it.effect('keeps the instance in force until the provider no longer serves', () => {
    const tokens: string[] = []
    const factory: IssueControlFactoryPort = {
      make: (candidate) =>
        Effect.sync((): IssueControlPort => {
          tokens.push(stubProviderToken(candidate))
          return { ...stub }
        }),
      serves: (left, right) => stubProviderToken(left) === stubProviderToken(right),
    }

    return Effect.gen(function* () {
      const instances = yield* withCell(
        factory,
        Effect.all([
          issueControlFor(provider('first')),
          issueControlFor(provider('first')),
          issueControlFor(provider('second')),
        ]),
      )

      expect(tokens).toEqual(['first', 'second'])
      expect(instances[0]).toBe(instances[1])
      expect(instances[2]).not.toBe(instances[0])
    })
  })

  it.effect('builds the instance once for concurrent readers', () => {
    let builds = 0
    return Effect.gen(function* () {
      const reading = yield* Effect.fork(
        withCell(
          {
            make: () =>
              Effect.sync((): IssueControlPort => {
                builds += 1
                return stub
              }).pipe(Effect.delay('10 millis')),
            serves: () => true,
          },
          Effect.gen(function* () {
            const readers = yield* Effect.forkAll([
              issueControlFor(provider('first')),
              issueControlFor(provider('first')),
            ])
            return yield* Fiber.join(readers)
          }),
        ),
      )
      // The construction delay is virtual: both readers are already waiting on the one build.
      yield* TestClock.adjust('10 millis')
      const built = yield* Fiber.join(reading)

      expect(builds).toBe(1)
      expect(built[0]).toBe(built[1])
    })
  })
})
