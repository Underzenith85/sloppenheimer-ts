import { existsSync } from 'node:fs'
import { access, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Fiber } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { issueIdentifier, type Workspace } from '../src/domain.js'
import type { HooksConfig } from '../src/workflow.js'
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

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
  return predicate()
}

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const makeRoot = (): string => {
  const root = join('/tmp', `symphony-hooks-${crypto.randomUUID()}`)
  roots.push(root)
  return root
}

const hooks = (overrides: Partial<HooksConfig> = {}): HooksConfig => ({
  afterCreate: null,
  beforeRun: null,
  afterRun: null,
  beforeRemove: null,
  timeoutMs: 10_000,
  ...overrides,
})

const workspaceFor = (root: string, key: string): Workspace => ({
  path: join(root, key),
  key,
  createdNow: false,
})

describe('hook process hardening', (): void => {
  it('drains a hook that writes far more than the capture limit', async (): Promise<void> => {
    const root = makeRoot()
    const manager = makeWorkspaceManager(
      root,
      hooks({ afterCreate: `head -c 400000 /dev/zero | tr '\\0' 'a'` }),
    )

    const workspace = await Effect.runPromise(manager.create(issueIdentifier('GH-100')))

    expect(workspace.createdNow).toBe(true)
  })

  it('truncates captured diagnostics in a hook failure', async (): Promise<void> => {
    const root = makeRoot()
    const manager = makeWorkspaceManager(
      root,
      hooks({ afterCreate: `head -c 400000 /dev/zero | tr '\\0' 'b' >&2; exit 3` }),
    )

    const error = await Effect.runPromise(Effect.flip(manager.create(issueIdentifier('GH-101'))))

    expect(error.category).toBe('hook_failed')
    expect(error.message).toContain('exited with 3')
    expect(error.message).toContain('(truncated)')
    expect(error.message.length).toBeLessThan(2_000)
  })

  it('reports a nonzero exit with the hook phase', async (): Promise<void> => {
    const root = makeRoot()
    await Effect.runPromise(makeWorkspaceManager(root, hooks()).create(issueIdentifier('GH-102')))
    const manager = makeWorkspaceManager(root, hooks({ beforeRun: 'echo "boom" >&2; exit 7' }))

    const error = await Effect.runPromise(
      Effect.flip(manager.beforeRun(workspaceFor(root, 'GH-102'))),
    )

    expect(error.category).toBe('hook_failed')
    expect(error.message).toContain('before_run hook exited with 7')
    expect(error.message).toContain('boom')
  })

  it('terminates the whole hook process tree on timeout', async (): Promise<void> => {
    const root = makeRoot()
    await Effect.runPromise(makeWorkspaceManager(root, hooks()).create(issueIdentifier('GH-103')))
    const workspace = workspaceFor(root, 'GH-103')
    const manager = makeWorkspaceManager(
      root,
      hooks({
        beforeRun: 'sleep 120 & echo $! > grandchild.pid; wait',
        timeoutMs: 250,
      }),
    )

    const error = await Effect.runPromise(Effect.flip(manager.beforeRun(workspace)))
    const grandchild = Number(
      (await readFile(join(workspace.path, 'grandchild.pid'), 'utf8')).trim(),
    )

    expect(error.category).toBe('hook_timeout')
    expect(Number.isSafeInteger(grandchild)).toBe(true)
    expect(await waitFor(() => !processIsAlive(grandchild))).toBe(true)
  })

  it('terminates the hook process tree when the effect is interrupted', async (): Promise<void> => {
    const root = makeRoot()
    await Effect.runPromise(makeWorkspaceManager(root, hooks()).create(issueIdentifier('GH-104')))
    const workspace = workspaceFor(root, 'GH-104')
    const manager = makeWorkspaceManager(
      root,
      hooks({ beforeRun: 'sleep 120 & echo $! > grandchild.pid; wait' }),
    )

    const fiber = Effect.runFork(manager.beforeRun(workspace))
    await waitFor(() => existsSync(join(workspace.path, 'grandchild.pid')))
    const grandchild = Number(
      (await readFile(join(workspace.path, 'grandchild.pid'), 'utf8')).trim(),
    )
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(Number.isSafeInteger(grandchild)).toBe(true)
    expect(await waitFor(() => !processIsAlive(grandchild))).toBe(true)
  })
})

describe('hook phase semantics', (): void => {
  it('treats after_create as fatal for the workspace', async (): Promise<void> => {
    const root = makeRoot()
    const manager = makeWorkspaceManager(root, hooks({ afterCreate: 'exit 1' }))

    const error = await Effect.runPromise(Effect.flip(manager.create(issueIdentifier('GH-105'))))

    expect(error.category).toBe('hook_failed')
    expect(error.message).toContain('after_create')
  })

  it('treats after_run as best effort', async (): Promise<void> => {
    const root = makeRoot()
    await Effect.runPromise(makeWorkspaceManager(root, hooks()).create(issueIdentifier('GH-106')))
    const manager = makeWorkspaceManager(root, hooks({ afterRun: 'exit 1' }))

    await expect(
      Effect.runPromise(manager.afterRun(workspaceFor(root, 'GH-106'))),
    ).resolves.toBeUndefined()
  })

  it('removes the workspace even when before_remove fails', async (): Promise<void> => {
    const root = makeRoot()
    const created = await Effect.runPromise(
      makeWorkspaceManager(root, hooks()).create(issueIdentifier('GH-107')),
    )
    const manager = makeWorkspaceManager(root, hooks({ beforeRemove: 'exit 1' }))

    await Effect.runPromise(manager.remove(issueIdentifier('GH-107')))

    expect(existsSync(created.path)).toBe(false)
  })

  it('runs before_remove only when the workspace directory exists', async (): Promise<void> => {
    const root = makeRoot()
    const marker = join(root, 'before-remove-ran')
    const manager = makeWorkspaceManager(
      root,
      hooks({ beforeRemove: `printf ran > ${JSON.stringify(marker)}` }),
    )

    await Effect.runPromise(manager.remove(issueIdentifier('GH-108')))
    expect(existsSync(marker)).toBe(false)

    await Effect.runPromise(makeWorkspaceManager(root, hooks()).create(issueIdentifier('GH-108')))
    await Effect.runPromise(manager.remove(issueIdentifier('GH-108')))
    expect(existsSync(marker)).toBe(true)
  })
})

describe('workspace inspection and cleanup', (): void => {
  it('removes a missing workspace without running before_remove', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    roots.push(root)
    const manager = makeWorkspaceManager(root, {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: 'touch hook-ran',
      timeoutMs: 5_000,
    })

    await Effect.runPromise(manager.remove(issueIdentifier('GH-9')))

    await expect(access(root)).rejects.toThrow()
  })

  it('reports whether a contained workspace exists', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    roots.push(root)
    const manager = makeWorkspaceManager(root, {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 5_000,
    })
    const identifier = issueIdentifier('GH-11')

    expect(await Effect.runPromise(manager.exists(identifier))).toBe(false)
    await Effect.runPromise(manager.create(identifier))
    expect(await Effect.runPromise(manager.exists(identifier))).toBe(true)
  })

  it('rejects symlinked workspaces before running removal hooks', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    const outside = join('/tmp', `symphony-outside-${crypto.randomUUID()}`)
    roots.push(root, outside)
    await mkdir(root)
    await mkdir(outside)
    const identifier = issueIdentifier('GH-12')
    await symlink(outside, join(root, workspaceKey(identifier)), 'dir')
    const manager = makeWorkspaceManager(root, {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: 'touch hook-ran',
      timeoutMs: 5_000,
    })

    await expect(Effect.runPromise(manager.exists(identifier))).rejects.toThrow()
    await expect(Effect.runPromise(manager.remove(identifier))).rejects.toThrow()
    await expect(access(join(outside, 'hook-ran'))).rejects.toThrow()
  })

  it('logs and ignores before_remove failure while deleting the workspace', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    roots.push(root)
    const manager = makeWorkspaceManager(root, {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: 'exit 7',
      timeoutMs: 5_000,
    })
    const workspace = await Effect.runPromise(manager.create(issueIdentifier('GH-10')))

    await Effect.runPromise(manager.remove(issueIdentifier('GH-10')))

    await expect(access(workspace.path)).rejects.toThrow()
  })
})
