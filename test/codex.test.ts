import { describe, expect, it } from 'vitest'

import { boundedMessage, makeCodexEnvironment, telemetryFrom } from '../src/codex.js'

describe('Codex child environment', (): void => {
  it('removes custom tracker secrets and every GitHub authentication alias', (): void => {
    const secret = 'custom-tracker-secret'
    const environment = makeCodexEnvironment(
      {
        CUSTOM_GITHUB_TOKEN: secret,
        GITHUB_TOKEN: 'github-token',
        GH_TOKEN: 'gh-token',
        SAFE_VALUE: 'visible',
      },
      ['CUSTOM_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'],
    )

    expect(environment).toEqual({ SAFE_VALUE: 'visible' })
    expect(JSON.stringify(environment)).not.toContain(secret)
  })

  it('never removes authentication sources required by Codex itself', (): void => {
    const environment = makeCodexEnvironment(
      {
        OPENAI_API_KEY: 'openai-key',
        CODEX_ACCESS_TOKEN: 'codex-access-token',
        CUSTOM_GITHUB_TOKEN: 'tracker-token',
      },
      ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CUSTOM_GITHUB_TOKEN'],
    )

    expect(environment).toEqual({
      OPENAI_API_KEY: 'openai-key',
      CODEX_ACCESS_TOKEN: 'codex-access-token',
    })
  })
})

describe('Codex event message redaction', (): void => {
  it('redacts quoted JSON and object-like credential fields', (): void => {
    expect(
      boundedMessage(String.raw`{"token":"secret","password":"two words",'api_key':'also-secret'}`),
    ).toBe(String.raw`{"token":"[REDACTED]","password":"[REDACTED]",'api_key':'[REDACTED]'}`)
  })
})

describe('Codex protocol telemetry', (): void => {
  it('extracts the absolute total from thread token usage updates', (): void => {
    const telemetry = telemetryFrom('thread/tokenUsage/updated', {
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
          total: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
        },
      },
    })

    expect(telemetry).toEqual({
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      rateLimits: null,
    })
  })

  it('ignores response deltas and generic usage maps', (): void => {
    expect(
      telemetryFrom('rawResponse/completed', {
        params: { usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } },
      }),
    ).toEqual({ usage: null, rateLimits: null })
    expect(
      telemetryFrom('other/notification', {
        params: { usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } },
      }),
    ).toEqual({ usage: null, rateLimits: null })
  })

  it('extracts legacy cumulative totals and rate limits without using last-token deltas', (): void => {
    const telemetry = telemetryFrom('codex/event/token_count', {
      params: {
        msg: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 },
            last_token_usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 },
          },
          rate_limits: { primary: { used_percent: 25, window_minutes: 300 } },
        },
      },
    })

    expect(telemetry.usage).toEqual({ inputTokens: 90, outputTokens: 10, totalTokens: 100 })
    expect(telemetry.rateLimits).toEqual({
      primary: { used_percent: 25, window_minutes: 300 },
    })
  })

  it('tracks the targeted account rate-limit notification', (): void => {
    const telemetry = telemetryFrom('account/rateLimits/updated', {
      params: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 31, windowDurationMins: 15, resetsAt: 1_730_948_100 },
        },
      },
    })

    expect(telemetry.rateLimits).toEqual({
      limitId: 'codex',
      primary: { usedPercent: 31, windowDurationMins: 15, resetsAt: 1_730_948_100 },
    })
  })
})
