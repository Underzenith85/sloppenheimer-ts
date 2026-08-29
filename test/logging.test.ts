import { Effect, Logger } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { logInfo, redactSecretsInString } from '../src/logging.js'

describe('operator logging', (): void => {
  it('redacts credentials embedded in quoted structured strings', (): void => {
    expect(
      redactSecretsInString(
        String.raw`failure: {"token":"secret","password":"two words","client_secret":"hidden","access_token":"access","clientSecret":"oauth"} payload: {\"token\":\"nested-secret\"} OPENAI_API_KEY=openai CODEX_ACCESS_TOKEN=codex PASSWORD="two words hidden" Authorization: Basic dXNlcjpwYXNz`,
      ),
    ).toBe(
      String.raw`failure: {"token":"[REDACTED]","password":"[REDACTED]","client_secret":"[REDACTED]","access_token":"[REDACTED]","clientSecret":"[REDACTED]"} payload: {\"token\":\"[REDACTED]\"} OPENAI_API_KEY=[REDACTED] CODEX_ACCESS_TOKEN=[REDACTED] PASSWORD=[REDACTED] Authorization=[REDACTED]`,
    )
  })

  it('keeps orchestration effects alive when the configured sink throws', async (): Promise<void> => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const failingLogger = Logger.replace(
      Logger.defaultLogger,
      Logger.make(() => {
        throw new Error('sink unavailable')
      }),
    )

    await expect(
      Effect.runPromise(
        logInfo('action=test outcome=completed').pipe(Effect.provide(failingLogger)),
      ),
    ).resolves.toBeUndefined()
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('logging_sink_failed=true'))
    stderr.mockRestore()
  })
})
