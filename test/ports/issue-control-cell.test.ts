import { Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import type { ValidatedTrackerProvider } from '../../src/config/workflow.js'
import type { TrackerError } from '../../src/errors.js'
import {
  CurrentIssueControl,
  issueControlFor,
  layerCurrentIssueControl,
  layerIssueControlFactory,
  type IssueControlFactoryPort,
  type IssueControlPort,
} from '../../src/ports/index.js'
import { stubProvider, stubProviderToken } from '../harness/stub-tracker-provider.js'

const provider = (token: string): ValidatedTrackerProvider => stubProvider(token)

const stub: IssueControlPort = {
  listOpenIssues: () => Effect.succeed([]),
  addLabel: () => Effect.void,
}

const withCell = <Value>(
  factory: IssueControlFactoryPort,
  program: Effect.Effect<Value, TrackerError, CurrentIssueControl>,
): Promise<Value> =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(layerCurrentIssueControl),
      Effect.provide(layerIssueControlFactory(factory)),
    ),
  )

describe('issue-control cell', (): void => {
  it('keeps the instance in force until the provider no longer serves', async (): Promise<void> => {
    const tokens: string[] = []
    const factory: IssueControlFactoryPort = {
      make: (candidate) =>
        Effect.sync((): IssueControlPort => {
          tokens.push(stubProviderToken(candidate))
          return { ...stub }
        }),
      serves: (left, right) => stubProviderToken(left) === stubProviderToken(right),
    }

    const instances = await withCell(
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

  it('builds the instance once for concurrent readers', async (): Promise<void> => {
    let builds = 0
    const built = await withCell(
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
    )

    expect(builds).toBe(1)
    expect(built[0]).toBe(built[1])
  })
})
