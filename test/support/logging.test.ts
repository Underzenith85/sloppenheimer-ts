import { it } from '@effect/vitest'
import { Effect, Logger } from 'effect'
import { describe, expect, vi } from 'vitest'

import { logInfo, withLogAnnotations } from '@sloppenheimer/core/support/logging.js'
import { redactSecretsInString } from '@sloppenheimer/core/support/redaction.js'

describe('operator logging', (): void => {
  it('redacts credentials embedded in quoted structured strings', (): void => {
    expect(
      redactSecretsInString(
        String.raw`failure: {"token":"secret","password":"two words","client_secret":"hidden","access_token":"access","clientSecret":"oauth","auth.token":"dotted","session_id":"session-secret","session-id":"dash-secret","request.cookie":"cookie-secret","headers.set-cookie":"set-cookie-secret","requestCookie":"camel-cookie-secret"} payload: {\"token\":\"nested-secret\",\"refreshToken\":\"abc\\\"DEF\"} OPENAI_API_KEY=openai CODEX_ACCESS_TOKEN=codex AWS_SECRET_ACCESS_KEY=aws PASSWORD="two words hidden"
Authorization: AWS4-HMAC-SHA256 Credential=key, SignedHeaders=host, Signature=signature-secret`,
      ),
    ).toBe(
      String.raw`failure: {"token":"[REDACTED]","password":"[REDACTED]","client_secret":"[REDACTED]","access_token":"[REDACTED]","clientSecret":"[REDACTED]","auth.token":"[REDACTED]","session_id":"[REDACTED]","session-id":"[REDACTED]","request.cookie":"[REDACTED]","headers.set-cookie":"[REDACTED]","requestCookie":"[REDACTED]"} payload: {\"token\":\"[REDACTED]\",\"refreshToken\":\"[REDACTED]\"} OPENAI_API_KEY=[REDACTED] CODEX_ACCESS_TOKEN=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED] PASSWORD=[REDACTED]
Authorization=[REDACTED]`,
    )
    expect(redactSecretsInString('Cookie: sessionid=secret\nSet-Cookie: auth=secret')).toBe(
      'Cookie=[REDACTED]\nSet-Cookie=[REDACTED]',
    )
    expect(redactSecretsInString('DATABASE_URL=postgres://alice:hunter2@example.com/db')).toBe(
      'DATABASE_URL=postgres://[REDACTED]@example.com/db',
    )
    expect(redactSecretsInString('safe=value PASSWORD=two words hidden')).toBe(
      'safe=value PASSWORD=[REDACTED]',
    )
    expect(
      redactSecretsInString(
        'PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nc2VjcmV0LWtleS1ib2R5\n-----END PRIVATE KEY-----',
      ),
    ).toBe('PRIVATE_KEY=[REDACTED]')
    expect(
      redactSecretsInString(
        '-----BEGIN PGP PRIVATE KEY BLOCK-----\nc2VjcmV0LXBncC1rZXk=\n-----END PGP PRIVATE KEY BLOCK-----',
      ),
    ).toBe('[REDACTED PEM PRIVATE KEY]')
  })

  it.effect('keeps orchestration effects alive when the configured sink throws', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const failingLogger = Logger.replace(
      Logger.defaultLogger,
      Logger.make(() => {
        throw new Error('sink unavailable')
      }),
    )

    return Effect.gen(function* () {
      const logged = yield* logInfo('action=test outcome=completed').pipe(
        Effect.provide(failingLogger),
      )

      expect(logged).toBeUndefined()
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('logging_sink_failed=true'))
    }).pipe(
      // Restored after the assertions read the spy, and on a failing assertion too, so the stub
      // never leaks into the next test.
      Effect.ensuring(
        Effect.sync(() => {
          stderr.mockRestore()
        }),
      ),
    )
  })

  it.effect('does not expose objects beyond the structured-log depth limit', () =>
    Effect.gen(function* () {
      const entries: unknown[] = []
      const collectingLogger = Logger.replace(
        Logger.defaultLogger,
        Logger.make((entry) => {
          entries.push(entry)
        }),
      )

      yield* logInfo('action=test outcome=completed', {
        a: { b: { c: { d: { e: { token: 'deep-secret' } } } } },
        proxyAuthorization: 'Basic structured-secret',
        session_id: 'structured-session-secret',
        requestCookie: 'structured-cookie-secret',
      }).pipe(Effect.provide(collectingLogger))

      expect(JSON.stringify(entries)).not.toContain('deep-secret')
      expect(JSON.stringify(entries)).not.toContain('structured-secret')
      expect(JSON.stringify(entries)).not.toContain('structured-session-secret')
      expect(JSON.stringify(entries)).not.toContain('structured-cookie-secret')
      expect(JSON.stringify(entries)).toContain('[TRUNCATED]')
      expect(JSON.stringify(entries)).toContain('"action":"unspecified"')
      expect(JSON.stringify(entries)).toContain('"outcome":"unknown"')
      expect(JSON.stringify(entries)).toContain('"error":null')
    }),
  )

  it.effect('redacts and bounds propagated operation annotations', () =>
    Effect.gen(function* () {
      const entries: unknown[] = []
      const collectingLogger = Logger.replace(
        Logger.defaultLogger,
        Logger.make((entry) => entries.push(entry)),
      )
      yield* logInfo('inside operation').pipe(
        withLogAnnotations({ token: 'secret', issue_id: 'x'.repeat(2_000) }),
        Effect.provide(collectingLogger),
      )

      const serialized = JSON.stringify(entries)
      expect(serialized).not.toContain('secret')
      expect(serialized).toContain('[REDACTED]')
      expect(serialized).not.toContain('x'.repeat(1_025))
    }),
  )
})
