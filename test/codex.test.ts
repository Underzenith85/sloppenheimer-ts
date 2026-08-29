import { describe, expect, it } from 'vitest'

import { makeCodexEnvironment } from '../src/codex.js'

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
