import { describe, expect, it } from 'vitest'

import { runFailureWithEnvironment, runWithEnvironment } from '../harness/environment.js'

import { githubTrackerProvider } from '../../src/adapters/github/index.js'
import {
  makeTrackerProviderRegistry,
  sameTrackerProvider,
  trackerProviderOf,
  type ValidatedTrackerProvider,
} from '../../src/domain/tracker-provider.js'
import { WorkflowError } from '../../src/errors.js'
import {
  stubProvider,
  stubProviderToken,
  stubTrackerProviderAdapter,
  stubTrackerProviderEntry,
  stubTrackerProviders,
} from '../harness/stub-tracker-provider.js'

const authored = { owner: 'example', repository: 'symphony', token: '$TRACKER_TOKEN' }

const github = (token: string): ValidatedTrackerProvider =>
  runWithEnvironment(githubTrackerProvider.validate(authored), { TRACKER_TOKEN: token })

describe('tracker provider registry', (): void => {
  it('derives the supported kinds from the registered adapters', (): void => {
    const registry = makeTrackerProviderRegistry([githubTrackerProvider])

    expect(registry.kinds).toEqual(['github'])
    expect(runFailureWithEnvironment(registry.validate('linear', {})).message).toBe(
      'unsupported tracker.kind: linear (supported: github)',
    )
  })

  /*
   * The registry's reason to exist: a kind declared nowhere under `config/` or `core/` validates,
   * compares, and reads back through exactly the surface GitHub's does.
   */
  it('supports a kind registered outside the configuration and core layers', (): void => {
    const registry = makeTrackerProviderRegistry([githubTrackerProvider, stubTrackerProviderEntry])

    const validated = runWithEnvironment(
      registry.validate('stub', { token: 'STUB_TRACKER_TOKEN' }),
      {
        STUB_TRACKER_TOKEN: 'secret',
      },
    )

    expect(registry.kinds).toEqual(['github', 'stub'])
    expect(validated.kind).toBe('stub')
    expect(stubProviderToken(validated)).toBe('secret')
    expect(validated.secretEnvironmentNames).toEqual(['STUB_TRACKER_TOKEN'])
    expect(runFailureWithEnvironment(registry.validate('linear', {})).message).toBe(
      'unsupported tracker.kind: linear (supported: github, stub)',
    )
  })

  it('delegates equality to the adapter that owns the kind', (): void => {
    expect(sameTrackerProvider(github('secret'), github('secret'))).toBe(true)
    expect(sameTrackerProvider(github('secret'), github('rotated'))).toBe(false)
    expect(sameTrackerProvider(github('secret'), stubProvider('secret'))).toBe(false)
  })

  it('carries the adapter-declared secret provenance without decoding the provider', (): void => {
    const validated = github('secret')

    expect(validated.kind).toBe('github')
    expect(validated.secretEnvironmentNames).toEqual(['TRACKER_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'])
  })

  it('revalidates through the adapter that produced the selection', (): void => {
    const authored = { token: 'STUB_TRACKER_TOKEN' }
    const validated = runWithEnvironment(stubTrackerProviders.validate('stub', authored), {
      STUB_TRACKER_TOKEN: 'secret',
    })

    const rotated = runWithEnvironment(validated.revalidate(authored), {
      STUB_TRACKER_TOKEN: 'rotated',
    })

    expect(rotated.kind).toBe('stub')
    expect(stubProviderToken(rotated)).toBe('rotated')
    expect(sameTrackerProvider(rotated, validated)).toBe(false)
    expect(
      sameTrackerProvider(
        runWithEnvironment(rotated.revalidate(authored), { STUB_TRACKER_TOKEN: 'rotated' }),
        rotated,
      ),
    ).toBe(true)
  })

  it('refuses to read a selection back through another adapter', (): void => {
    const read = (): unknown => trackerProviderOf(stubTrackerProviderAdapter, github('secret'))

    expect(read).toThrow(WorkflowError)
    expect(read).toThrow('tracker provider github is not a stub provider')
  })
})
