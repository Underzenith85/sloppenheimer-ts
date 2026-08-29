import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeCodexEnvironment, runAgent } from '../src/codex.js'
import { issueId, issueIdentifier, type Issue, type Workspace } from '../src/domain.js'
import type { CodexConfig } from '../src/workflow.js'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const temporaryDirectories: string[] = []

const issue: Issue = {
  id: issueId('13'),
  nativeRef: null,
  identifier: issueIdentifier('GH-13'),
  title: 'Revalidate workspace containment',
  description: null,
  priority: null,
  state: 'open',
  branchName: null,
  url: null,
  assigneeId: null,
  labels: [],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
}

const config: CodexConfig = {
  command: 'codex app-server',
  approvalPolicy: 'never',
  threadSandbox: 'workspace-write',
  turnSandboxPolicy: null,
  turnTimeoutMs: 1_000,
  readTimeoutMs: 1_000,
  stallTimeoutMs: 1_000,
}

const runInvalidWorkspace = async (root: string, workspace: Workspace): Promise<void> => {
  const result = await Effect.runPromise(
    Effect.either(
      runAgent(
        issue,
        workspace,
        root,
        config,
        'prompt',
        1,
        [],
        () => Effect.succeed(issue),
        () => true,
        () => undefined,
      ),
    ),
  )

  expect(result._tag).toBe('Left')
  if (result._tag === 'Left') {
    expect(result.left.category).toBe('invalid_workspace')
  }
  expect(spawnMock).not.toHaveBeenCalled()
}

afterEach(async (): Promise<void> => {
  spawnMock.mockReset()
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

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

describe('Codex workspace launch boundary', (): void => {
  it('never spawns Codex for adversarial or stale workspace paths', async (): Promise<void> => {
    const key = issue.identifier

    const equalityRoot = await mkdtemp(join(tmpdir(), 'symphony-launch-equality-'))
    temporaryDirectories.push(equalityRoot)
    await runInvalidWorkspace(equalityRoot, {
      path: equalityRoot,
      key,
      createdNow: false,
    })

    const traversalRoot = await mkdtemp(join(tmpdir(), 'symphony-launch-traversal-'))
    temporaryDirectories.push(traversalRoot)
    await mkdir(join(traversalRoot, key))
    await runInvalidWorkspace(traversalRoot, {
      path: `${traversalRoot}/${key}/../${key}`,
      key,
      createdNow: false,
    })

    const escapeRoot = await mkdtemp(join(tmpdir(), 'symphony-launch-escape-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'symphony-launch-outside-'))
    temporaryDirectories.push(escapeRoot, outside)
    await runInvalidWorkspace(escapeRoot, { path: outside, key, createdNow: false })

    const symlinkRoot = await mkdtemp(join(tmpdir(), 'symphony-launch-symlink-'))
    const symlinkTarget = await mkdtemp(join(tmpdir(), 'symphony-launch-target-'))
    temporaryDirectories.push(symlinkRoot, symlinkTarget)
    await symlink(symlinkTarget, join(symlinkRoot, key), 'dir')
    await runInvalidWorkspace(symlinkRoot, {
      path: join(symlinkRoot, key),
      key,
      createdNow: false,
    })

    const fileRoot = await mkdtemp(join(tmpdir(), 'symphony-launch-file-'))
    temporaryDirectories.push(fileRoot)
    await writeFile(join(fileRoot, key), 'not a directory')
    await runInvalidWorkspace(fileRoot, {
      path: join(fileRoot, key),
      key,
      createdNow: false,
    })

    const staleRoot = await mkdtemp(join(tmpdir(), 'symphony-launch-stale-'))
    temporaryDirectories.push(staleRoot)
    await runInvalidWorkspace(staleRoot, {
      path: join(staleRoot, key),
      key,
      createdNow: false,
    })

    const mismatchedRoot = await mkdtemp(join(tmpdir(), 'symphony-launch-mismatch-'))
    temporaryDirectories.push(mismatchedRoot)
    const otherKey = 'GH-12'
    await mkdir(join(mismatchedRoot, otherKey))
    await runInvalidWorkspace(mismatchedRoot, {
      path: join(mismatchedRoot, otherKey),
      key: otherKey,
      createdNow: false,
    })
  })
})
