import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  boundedMessage,
  makeCodexEnvironment,
  runAgent,
  telemetryFrom,
  type AgentLaunch,
} from '../../../src/adapters/codex/codex.js'
import { issueId, issueIdentifier, type Issue, type Workspace } from '../../../src/domain/domain.js'
import type { CodexConfig } from '../../../src/config/workflow.js'
import {
  assertWorkspaceIdentity,
  openVerifiedWorkspace,
  verifyWorkspaceForLaunch,
} from '../../../src/adapters/node/workspace-identity.js'

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

  it('redacts bare retained authentication values', (): void => {
    expect(
      boundedMessage('printed openai-secret and codex-secret', ['openai-secret', 'codex-secret']),
    ).toBe('printed [REDACTED] and [REDACTED]')
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

const spawnCalls: string[] = []

vi.mock(
  'node:child_process',
  async (importOriginal): Promise<typeof import('node:child_process')> => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
      ...actual,
      spawn: ((...arguments_: Parameters<typeof actual.spawn>) => {
        spawnCalls.push(String(arguments_[0]))
        return actual.spawn(...arguments_)
      }) as typeof actual.spawn,
    }
  },
)

const roots: string[] = []

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'symphony-launch-'))
  roots.push(root)
  return root
}

afterEach(async (): Promise<void> => {
  spawnCalls.length = 0
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const codexConfig: CodexConfig = {
  command: 'cat',
  approvalPolicy: 'never',
  threadSandbox: 'workspace-write',
  turnSandboxPolicy: null,
  turnTimeoutMs: 1_000,
  readTimeoutMs: 200,
  stallTimeoutMs: 0,
}

const launchIssue: Issue = {
  id: issueId('13'),
  nativeRef: null,
  identifier: issueIdentifier('example/symphony#13'),
  title: 'Revalidate containment',
  description: null,
  priority: null,
  state: 'open',
  branchName: null,
  url: null,
  assigneeId: null,
  labels: ['symphony'],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
}

const launchFor = (root: string, workspace: Workspace): AgentLaunch => ({
  issue: launchIssue,
  workspace,
  workspaceRoot: root,
  config: codexConfig,
  prompt: 'work',
  maxTurns: 1,
  secretEnvironmentNames: [],
  refreshIssue: () => Effect.succeed(null),
  isRoutable: () => false,
  onEvent: () => undefined,
})

const workspaceAt = (path: string, key: string): Workspace => ({ path, key, createdNow: false })

describe('workspace containment at the agent launch boundary', (): void => {
  it('rejects a workspace that is the configured root itself', async (): Promise<void> => {
    const root = await makeRoot()

    const error = await Effect.runPromise(
      Effect.flip(runAgent(launchFor(root, workspaceAt(root, '.')))),
    )

    expect(error.category).toBe('workspace_rejected')
    expect(spawnCalls).toEqual([])
  })

  it('rejects a traversal path that climbs out of the root', async (): Promise<void> => {
    const root = await makeRoot()

    const error = await Effect.runPromise(
      Effect.flip(runAgent(launchFor(root, workspaceAt(join(root, '..', 'elsewhere'), 'x')))),
    )

    expect(error.category).toBe('workspace_rejected')
    expect(spawnCalls).toEqual([])
  })

  it('rejects an absolute path outside the root', async (): Promise<void> => {
    const root = await makeRoot()

    const error = await Effect.runPromise(
      Effect.flip(runAgent(launchFor(root, workspaceAt('/etc', 'etc')))),
    )

    expect(error.category).toBe('workspace_rejected')
    expect(spawnCalls).toEqual([])
  })

  it('rejects a workspace directory that was replaced by a symbolic link', async (): Promise<void> => {
    const root = await makeRoot()
    const outside = await makeRoot()
    const path = join(root, 'issue-13')
    await symlink(outside, path, 'dir')

    const error = await Effect.runPromise(
      Effect.flip(runAgent(launchFor(root, workspaceAt(path, 'issue-13')))),
    )

    expect(error.category).toBe('workspace_rejected')
    expect(error.message).toContain('symbolic link')
    expect(spawnCalls).toEqual([])
  })

  it('rejects a workspace path that was replaced by a file', async (): Promise<void> => {
    const root = await makeRoot()
    const path = join(root, 'issue-13')
    await writeFile(path, 'not a directory')

    const error = await Effect.runPromise(
      Effect.flip(runAgent(launchFor(root, workspaceAt(path, 'issue-13')))),
    )

    expect(error.category).toBe('workspace_rejected')
    expect(error.message).toContain('not a directory')
    expect(spawnCalls).toEqual([])
  })

  it('rejects a stale workspace object whose directory is gone', async (): Promise<void> => {
    const root = await makeRoot()

    const error = await Effect.runPromise(
      Effect.flip(runAgent(launchFor(root, workspaceAt(join(root, 'removed'), 'removed')))),
    )

    expect(error.category).toBe('workspace_rejected')
    expect(error.message).toContain('not present')
    expect(spawnCalls).toEqual([])
  })

  it('rejects a workspace reached through a symlinked parent that escapes the root', async (): Promise<void> => {
    const root = await makeRoot()
    const outside = await makeRoot()
    await mkdir(join(outside, 'issue-13'))
    await symlink(outside, join(root, 'link'), 'dir')

    const error = await Effect.runPromise(
      Effect.flip(
        runAgent(launchFor(root, workspaceAt(join(root, 'link', 'issue-13'), 'issue-13'))),
      ),
    )

    expect(error.category).toBe('workspace_rejected')
    expect(error.message).toContain('escapes the configured root')
    expect(spawnCalls).toEqual([])
  })

  it('rejects a directory swapped for a symlink after verification', async (): Promise<void> => {
    const root = await makeRoot()
    const outside = await makeRoot()
    const path = join(root, 'issue-13')
    await mkdir(path)
    const verified = await Effect.runPromise(
      verifyWorkspaceForLaunch(root, workspaceAt(path, 'issue-13')),
    )

    // The directory is renamed away and the verified path repointed outside the root, exactly as a
    // process started by an earlier hook could do between verification and use.
    await rename(path, join(root, 'issue-13-moved'))
    await symlink(outside, path, 'dir')
    const error = await Effect.runPromise(Effect.flip(assertWorkspaceIdentity(root, verified)))

    expect(error.category).toBe('invalid_path')
  })

  it('rejects a directory deleted and recreated at the same path', async (): Promise<void> => {
    const root = await makeRoot()
    const path = join(root, 'issue-13')
    await mkdir(path)

    // The held handle keeps the inode allocated, so the recreated directory cannot reuse it.
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          openVerifiedWorkspace(root, workspaceAt(path, 'issue-13')).pipe(
            Effect.tap(() =>
              Effect.promise(async () => {
                await rm(path, { recursive: true })
                await mkdir(path)
              }),
            ),
            Effect.flatMap((verified) => assertWorkspaceIdentity(root, verified)),
          ),
        ),
      ),
    )

    expect(error.category).toBe('invalid_path')
    expect(error.message).toContain('identity changed')
  })

  it('verifies and re-binds a workspace under a symlinked root', async (): Promise<void> => {
    const target = await makeRoot()
    const linkedRoot = join(await makeRoot(), 'root-link')
    await symlink(target, linkedRoot, 'dir')
    const path = join(linkedRoot, 'issue-13')
    await mkdir(path)

    const verified = await Effect.runPromise(
      verifyWorkspaceForLaunch(linkedRoot, workspaceAt(path, 'issue-13')),
    )

    expect(verified.rootPath).toBe(await realpath(target))
    await expect(
      Effect.runPromise(assertWorkspaceIdentity(linkedRoot, verified)),
    ).resolves.toBeUndefined()
  })

  it('rejects a configured root that is repointed after verification', async (): Promise<void> => {
    const target = await makeRoot()
    const elsewhere = await makeRoot()
    const linkedRoot = join(await makeRoot(), 'root-link')
    await symlink(target, linkedRoot, 'dir')
    const path = join(linkedRoot, 'issue-13')
    await mkdir(path)
    const verified = await Effect.runPromise(
      verifyWorkspaceForLaunch(linkedRoot, workspaceAt(path, 'issue-13')),
    )

    await rm(linkedRoot)
    await symlink(elsewhere, linkedRoot, 'dir')
    const error = await Effect.runPromise(
      Effect.flip(assertWorkspaceIdentity(linkedRoot, verified)),
    )

    expect(error.category).toBe('invalid_path')
    expect(error.message).toContain('root changed')
  })

  it('accepts an unchanged workspace at a later boundary', async (): Promise<void> => {
    const root = await makeRoot()
    const path = join(root, 'issue-13')
    await mkdir(path)
    const verified = await Effect.runPromise(
      verifyWorkspaceForLaunch(root, workspaceAt(path, 'issue-13')),
    )

    await expect(
      Effect.runPromise(assertWorkspaceIdentity(root, verified)),
    ).resolves.toBeUndefined()
  })

  it('launches Codex in the verified real path for a contained workspace', async (): Promise<void> => {
    const root = await makeRoot()
    const path = join(root, 'issue-13')
    await mkdir(path)

    const error = await Effect.runPromise(
      Effect.flip(runAgent(launchFor(root, workspaceAt(path, 'issue-13')))),
    )

    expect(error.category).not.toBe('workspace_rejected')
    expect(spawnCalls).toEqual(['bash'])
  })
})
