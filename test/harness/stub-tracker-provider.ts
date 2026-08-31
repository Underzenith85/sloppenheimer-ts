import { Config, Effect } from 'effect'

import {
  makeTrackerProviderRegistry,
  registerTrackerProvider,
  trackerProviderOf,
  type TrackerProviderAdapter,
  type TrackerProviderRegistry,
  type ValidatedTrackerProvider,
} from '../../src/domain/tracker-provider.js'
import { WorkflowError } from '../../src/errors.js'
import { withEnvironment } from './environment.js'

/**
 * A tracker kind that exists only here.
 *
 * Nothing under `src/config/` or `src/core/` knows this kind, which is the point: a test can
 * register an adapter and thread its validated selection through the ports and the reload path
 * exactly as the composition root threads GitHub's.
 */
export type StubProviderConfig = Readonly<{ token: string }>

const isStubProviderConfig = (value: unknown): value is StubProviderConfig => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return typeof (value as Record<string, unknown>)['token'] === 'string'
}

export const stubTrackerProviderAdapter: TrackerProviderAdapter<StubProviderConfig> = {
  kind: 'stub',
  validate: (provider) => {
    const reference = provider['token']
    if (typeof reference !== 'string' || reference.length === 0) {
      return Effect.fail(
        new WorkflowError({
          category: 'invalid_config',
          message: 'tracker.provider.token must be a non-empty string',
        }),
      )
    }
    // Reads the named variable through the calling fiber's provider, and falls back to the
    // reference itself so a selection can be built without an environment at all.
    return Config.option(Config.string(reference)).pipe(
      Effect.map((value) => ({ token: value._tag === 'Some' ? value.value : reference })),
      Effect.orDie,
    )
  },
  isProvider: isStubProviderConfig,
  same: (left, right) => left.token === right.token,
  secretEnvironmentNames: () => ['STUB_TRACKER_TOKEN'],
}

export const stubTrackerProviderEntry = registerTrackerProvider(stubTrackerProviderAdapter)

export const stubTrackerProviders: TrackerProviderRegistry = makeTrackerProviderRegistry([
  stubTrackerProviderEntry,
])

/**
 * A validated stub selection whose token is the literal given, resolved against no environment.
 * Run here rather than yielded: every caller is a module-scope fixture constant, and validation
 * against a fixed literal reads no environment and cannot fail.
 */
export const stubProvider = (token: string): ValidatedTrackerProvider =>
  Effect.runSync(withEnvironment(stubTrackerProviders.validate('stub', { token })))

export const stubProviderToken = (selection: ValidatedTrackerProvider): string =>
  trackerProviderOf(stubTrackerProviderAdapter, selection).token
