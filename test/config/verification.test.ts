import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { decodeFrontMatter } from '../../src/config/workflow/schema.js'
import { parseConfig } from '../../src/config/workflow/effective-config.js'

it.effect('decodes a bounded host verification gate separately from extension keys', () =>
  Effect.gen(function* () {
    const raw = yield* decodeFrontMatter({
      tracker: { kind: 'test', provider: {} },
      verification: { command: 'pnpm check', timeout_ms: 900_000 },
    })
    const config = parseConfig(
      raw,
      '/workspace',
      { kind: 'test', settings: {}, section: 'runner' },
      'agent',
    )
    expect(config.verification).toEqual({ command: 'pnpm check', timeoutMs: 900_000 })
    expect(config.extensions).toEqual({})
  }),
)

it.effect('rejects missing commands and invalid verification deadlines', () =>
  Effect.gen(function* () {
    for (const verification of [
      { command: '', timeout_ms: 10 },
      { command: 'check' },
      { command: 'check', timeout_ms: 0 },
      { command: 'check', timeout_ms: 2_147_483_648 },
    ]) {
      const result = yield* Effect.flip(
        decodeFrontMatter({
          tracker: { kind: 'test', provider: {} },
          verification,
        }),
      )
      expect(result.category).toBe('invalid_config')
    }
  }),
)
