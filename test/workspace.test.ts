import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { issueIdentifier } from '../src/domain.js'
import { containedWorkspacePath, makeWorkspaceManager, workspaceKey } from '../src/workspace.js'

const roots: string[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe('workspace safety', (): void => {
  it('uses stable collision-resistant keys for sanitized identifiers', (): void => {
    const first = workspaceKey(issueIdentifier('owner/repo#7'))
    const second = workspaceKey(issueIdentifier('owner_repo#7'))

    expect(first).toMatch(/^owner_repo_7-[a-f0-9]{16}$/u)
    expect(first).not.toBe(second)
    expect(workspaceKey(issueIdentifier('GH-7'))).toBe('GH-7')
  })

  it('rejects paths that escape or equal the root', (): void => {
    expect(() => containedWorkspacePath('/tmp/symphony-root', '..')).toThrow()
    expect(() => containedWorkspacePath('/tmp/symphony-root', '.')).toThrow()
  })

  it('runs after_create once and reuses the directory', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    roots.push(root)
    const manager = makeWorkspaceManager(root, {
      afterCreate: 'printf created > marker.txt',
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 5_000,
    })

    const first = await Effect.runPromise(manager.create(issueIdentifier('GH-8')))
    const second = await Effect.runPromise(manager.create(issueIdentifier('GH-8')))

    expect(first.createdNow).toBe(true)
    expect(second.createdNow).toBe(false)
    expect(await readFile(join(first.path, 'marker.txt'), 'utf8')).toBe('created')
  })
})
