import {
  makeTrackerProviderRegistry,
  type TrackerProviderRegistry,
} from './domain/tracker-provider.js'
import { githubTrackerProvider } from './adapters/github/index.js'

/**
 * The tracker kinds this build supports.
 *
 * This is the composition root's list, and the only place a kind is named: an adapter owns its own
 * validation, provider equality, and secret provenance, so adding a kind is one entry here and no
 * change under `config/` or `core/`.
 */
export const trackerProviders: TrackerProviderRegistry = makeTrackerProviderRegistry([
  githubTrackerProvider,
])
