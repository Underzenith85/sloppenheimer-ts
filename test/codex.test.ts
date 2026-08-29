import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeCodexEnvironment, runAgent, type AgentLaunch } from '../src/codex.js'
import { issueId, issueIdentifier, type Issue, type Workspace } from '../src/domain.js'
import type { CodexConfig } from '../src/workflow.js'
import {
  assertWorkspaceIdentity,
  openVerifiedWorkspace,
  verifyWorkspaceForLaunch,
} from '../src/workspace.js'

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
