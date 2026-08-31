import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { IssueControlPort, TrackerPort } from '../src/ports/index.js'
import { makeTrackerPortFactories, type RegisteredTrackerPorts } from '../src/tracker-adapters.js'
import { runWithEnvironment } from './harness/environment.js'
import {
  stubProvider,
  stubProviderToken,
  stubTrackerProviderEntry,
} from './harness/stub-tracker-provider.js'

const stubTracker = (token: string): TrackerPort => ({
  fetchIssuesByStates: () => Effect.succeed([]),
  fetchIssuesByIds: () => Effect.succeed([]),
  toolSpecs: [],
  executeTool: () => Promise.resolve({ success: true, data: null }),
  secretEnvironmentNames: [token],
})

const stubIssueControl = (token: string, built: string[]): IssueControlPort => {
  built.push(token)
  return {
    listOpenIssues: () => Effect.succeed([]),
    addLabel: () => Effect.void,
  }
}

describe('registered tracker port factories', (): void => {
  it('runs a second kind through its effectful registered ports and retires scoped resources', async (): Promise<void> => {
    const issueControls: string[] = []
    const releasedTrackers: string[] = []
    const entry: RegisteredTrackerPorts = {
      ...stubTrackerProviderEntry,
      tracker: (provider) => {
        const token = stubProviderToken(provider)
        return Effect.acquireRelease(Effect.succeed(stubTracker(token)), () =>
          Effect.sync(() => releasedTrackers.push(token)).pipe(Effect.asVoid),
        )
      },
      issueControl: (provider) =>
        Effect.succeed(stubIssueControl(stubProviderToken(provider), issueControls)),
    }
    const factories = makeTrackerPortFactories([entry])
    const provider = runWithEnvironment(
      factories.providers.validate('stub', { token: 'STUB_TOKEN' }),
      { STUB_TOKEN: 'second-kind-secret' },
    )

    const [tracker, issueControl, codeReview, sourceControl] = await Effect.runPromise(
      Effect.scoped(
        Effect.all([
          factories.tracker.make(provider),
          factories.issueControl.make(provider),
          factories.codeReview.make(provider),
          factories.sourceControl.make(provider),
        ]),
      ),
    )

    expect(tracker.secretEnvironmentNames).toEqual(['second-kind-secret'])
    expect(await Effect.runPromise(issueControl.listOpenIssues())).toEqual([])
    expect(issueControls).toEqual(['second-kind-secret'])
    expect(codeReview).toBeNull()
    expect(sourceControl).toBeNull()
    expect(releasedTrackers).toEqual(['second-kind-secret'])
  })

  it('reports a registered kind without a tracker factory as a typed error', async (): Promise<void> => {
    const entry: RegisteredTrackerPorts = { ...stubTrackerProviderEntry }
    const factories = makeTrackerPortFactories([entry])
    const result = await Effect.runPromise(
      Effect.either(Effect.scoped(factories.tracker.make(stubProvider('secret')))),
    )

    expect(result).toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'TrackerError',
        category: 'unsupported_tracker_kind',
        message: 'tracker.kind stub is registered but does not supply TrackerPort',
        retryable: false,
      },
    })
  })
})
