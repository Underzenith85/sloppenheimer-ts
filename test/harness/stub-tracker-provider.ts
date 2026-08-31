import {
  makeTrackerProviderRegistry,
  registerTrackerProvider,
  trackerProviderOf,
  type TrackerProviderAdapter,
  type TrackerProviderRegistry,
  type ValidatedTrackerProvider,
} from '../../src/domain/tracker-provider.js'
import { WorkflowError } from '../../src/errors.js'

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
  validate: (provider, environment) => {
    const reference = provider['token']
    if (typeof reference !== 'string' || reference.length === 0) {
      throw new WorkflowError({
        category: 'invalid_config',
        message: 'tracker.provider.token must be a non-empty string',
      })
    }
    return { token: environment[reference] ?? reference }
  },
  isProvider: isStubProviderConfig,
  same: (left, right) => left.token === right.token,
  secretEnvironmentNames: () => ['STUB_TRACKER_TOKEN'],
}

export const stubTrackerProviderEntry = registerTrackerProvider(stubTrackerProviderAdapter)

export const stubTrackerProviders: TrackerProviderRegistry = makeTrackerProviderRegistry([
  stubTrackerProviderEntry,
])

export const stubProvider = (token: string): ValidatedTrackerProvider =>
  stubTrackerProviders.validate('stub', { token }, {})

export const stubProviderToken = (selection: ValidatedTrackerProvider): string =>
  trackerProviderOf(stubTrackerProviderAdapter, selection).token
