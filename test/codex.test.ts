import { describe, expect, it } from 'vitest'

import { makeCodexEnvironment, makeTurnStartParams } from '../src/codex.js'
import type { CodexConfig, CodexSandboxPolicy } from '../src/workflow.js'

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

describe('Codex policy payloads', (): void => {
  const config = (turnSandboxPolicy: CodexSandboxPolicy | null): CodexConfig => ({
    command: 'codex app-server',
    approvalPolicy: 'never',
    threadSandbox: 'workspace-write',
    turnSandboxPolicy,
    turnTimeoutMs: 3_600_000,
    readTimeoutMs: 5_000,
    stallTimeoutMs: 300_000,
  })

  it('passes an explicit turn sandbox policy through to App Server unchanged', (): void => {
    const policy: CodexSandboxPolicy = {
      type: 'readOnly',
      networkAccess: false,
    }

    const params = makeTurnStartParams(
      'thread-1',
      { path: '/tmp/workspace', key: 'workspace', createdNow: false },
      config(policy),
      'Do the work',
    )

    expect(params['sandboxPolicy']).toBe(policy)
  })

  it('uses the documented workspace policy when no override is configured', (): void => {
    const params = makeTurnStartParams(
      'thread-1',
      { path: '/tmp/workspace', key: 'workspace', createdNow: false },
      config(null),
      'Do the work',
    )

    expect(params['sandboxPolicy']).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/tmp/workspace'],
      networkAccess: true,
    })
  })
})
