import { Effect, Logger } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { logInfo, redactSecretsInString } from '../src/logging.js'

describe('operator logging', (): void => {
  it('redacts credentials embedded in quoted structured strings', (): void => {
    expect(
      redactSecretsInString(
        String.raw`failure: {"token":"secret","password":"two words","client_secret":"hidden","access_token":"access","clientSecret":"oauth","auth.token":"dotted"} payload: {\"token\":\"nested-secret\",\"refreshToken\":\"abc\\\"DEF\"} OPENAI_API_KEY=openai CODEX_ACCESS_TOKEN=codex AWS_SECRET_ACCESS_KEY=aws PASSWORD="two words hidden"
Authorization: AWS4-HMAC-SHA256 Credential=key, SignedHeaders=host, Signature=signature-secret`,
      ),
    ).toBe(
      String.raw`failure: {"token":"[REDACTED]","password":"[REDACTED]","client_secret":"[REDACTED]","access_token":"[REDACTED]","clientSecret":"[REDACTED]","auth.token":"[REDACTED]"} payload: {\"token\":\"[REDACTED]\",\"refreshToken\":\"[REDACTED]\"} OPENAI_API_KEY=[REDACTED] CODEX_ACCESS_TOKEN=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED] PASSWORD=[REDACTED]
Authorization=[REDACTED]`,
    )
    expect(redactSecretsInString('Cookie: sessionid=secret\nSet-Cookie: auth=secret')).toBe(
      'Cookie=[REDACTED]\nSet-Cookie=[REDACTED]',
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

  it('does not expose objects beyond the structured-log depth limit', async (): Promise<void> => {
    const entries: unknown[] = []
    const collectingLogger = Logger.replace(
      Logger.defaultLogger,
      Logger.make((entry) => {
        entries.push(entry)
      }),
    )

    await Effect.runPromise(
      logInfo('action=test outcome=completed', {
        a: { b: { c: { d: { e: { token: 'deep-secret' } } } } },
      }).pipe(Effect.provide(collectingLogger)),
    )

    expect(JSON.stringify(entries)).not.toContain('deep-secret')
    expect(JSON.stringify(entries)).toContain('[TRUNCATED]')
  })
})
