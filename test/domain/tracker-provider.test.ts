import { it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { describe, expect } from 'vitest'

import { withEnvironment } from '../harness/environment.js'

import { githubTrackerProvider } from '@symphony/adapter-github'
import {
  makeTrackerProviderRegistry,
  sameTrackerProvider,
  trackerProviderOf,
  type ValidatedTrackerProvider,
} from '@symphony/core/domain/tracker-provider.js'
import { WorkflowError } from '@symphony/core/domain/errors.js'
import {
  stubProvider,
  stubProviderToken,
  stubTrackerProviderAdapter,
  stubTrackerProviderEntry,
  stubTrackerProviders,
} from '../harness/stub-tracker-provider.js'

const authored = { owner: 'example', repository: 'symphony', token: '$TRACKER_TOKEN' }

const github = (token: string): Effect.Effect<ValidatedTrackerProvider, WorkflowError> =>
  withEnvironment(githubTrackerProvider.validate(authored), { TRACKER_TOKEN: token })

describe('tracker provider registry', (): void => {
  it.effect('derives the supported kinds from the registered adapters', () =>
    Effect.gen(function* () {
      const registry = makeTrackerProviderRegistry([githubTrackerProvider])

      expect(registry.kinds).toEqual(['github'])
      const refused = yield* Effect.flip(withEnvironment(registry.validate('linear', {})))
      expect(refused.message).toBe('unsupported tracker.kind: linear (supported: github)')
    }),
  )

  /*
   * The registry's reason to exist: a kind declared nowhere under `config/` or `core/` validates,
   * compares, and reads back through exactly the surface GitHub's does.
   */
  it.effect('supports a kind registered outside the configuration and core layers', () =>
    Effect.gen(function* () {
      const registry = makeTrackerProviderRegistry([
        githubTrackerProvider,
        stubTrackerProviderEntry,
      ])

      const validated = yield* withEnvironment(
        registry.validate('stub', { token: 'STUB_TRACKER_TOKEN' }),
        { STUB_TRACKER_TOKEN: 'secret' },
      )

      expect(registry.kinds).toEqual(['github', 'stub'])
      expect(registry.get('stub')).toEqual(Option.some(stubTrackerProviderEntry))
      expect(registry.get('missing')).toEqual(Option.none())
      expect(validated.kind).toBe('stub')
      expect(stubProviderToken(validated)).toBe('secret')
      expect(validated.secretEnvironmentNames).toEqual(['STUB_TRACKER_TOKEN'])
      const refused = yield* Effect.flip(withEnvironment(registry.validate('linear', {})))
      expect(refused.message).toBe('unsupported tracker.kind: linear (supported: github, stub)')
    }),
  )

  it.effect('delegates equality to the adapter that owns the kind', () =>
    Effect.gen(function* () {
      const secret = yield* github('secret')
      const rotated = yield* github('rotated')

      expect(sameTrackerProvider(secret, yield* github('secret'))).toBe(true)
      expect(sameTrackerProvider(secret, rotated)).toBe(false)
      expect(sameTrackerProvider(secret, stubProvider('secret'))).toBe(false)
    }),
  )

  it.effect('carries the adapter-declared secret provenance without decoding the provider', () =>
    Effect.gen(function* () {
      const validated = yield* github('secret')

      expect(validated.kind).toBe('github')
      expect(validated.secretEnvironmentNames).toEqual([
        'TRACKER_TOKEN',
        'GITHUB_TOKEN',
        'GH_TOKEN',
      ])
    }),
  )

  it.effect('revalidates through the adapter that produced the selection', () =>
    Effect.gen(function* () {
      const authored = { token: 'STUB_TRACKER_TOKEN' }
      const validated = yield* withEnvironment(stubTrackerProviders.validate('stub', authored), {
        STUB_TRACKER_TOKEN: 'secret',
      })

      const rotated = yield* withEnvironment(validated.revalidate(authored), {
        STUB_TRACKER_TOKEN: 'rotated',
      })

      expect(rotated.kind).toBe('stub')
      expect(stubProviderToken(rotated)).toBe('rotated')
      expect(sameTrackerProvider(rotated, validated)).toBe(false)
      const again = yield* withEnvironment(rotated.revalidate(authored), {
        STUB_TRACKER_TOKEN: 'rotated',
      })
      expect(sameTrackerProvider(again, rotated)).toBe(true)
    }),
  )

  it.effect('refuses to read a selection back through another adapter', () =>
    Effect.gen(function* () {
      const validated = yield* github('secret')
      const read = (): unknown => trackerProviderOf(stubTrackerProviderAdapter, validated)

      expect(read).toThrow(WorkflowError)
      expect(read).toThrow('tracker provider github is not a stub provider')
    }),
  )
})
