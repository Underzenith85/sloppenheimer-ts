import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { issueIdentifier } from '../src/domain.js'
import { containedWorkspacePath, makeWorkspaceManager, workspaceKey } from '../src/workspace.js'
import type { HooksConfig } from '../src/workflow.js'

const roots: string[] = []

const hooks = (overrides: Partial<HooksConfig> = {}): HooksConfig => ({
  afterCreate: null,
  beforeRun: null,
  afterRun: null,
  beforeRemove: null,
  timeoutMs: 5_000,
  ...overrides,
})

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

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
    const manager = makeWorkspaceManager(
      root,
      hooks({ afterCreate: 'printf created > marker.txt' }),
    )

    const first = await Effect.runPromise(manager.create(issueIdentifier('GH-8')))
    const second = await Effect.runPromise(manager.create(issueIdentifier('GH-8')))

    expect(first.createdNow).toBe(true)
    expect(second.createdNow).toBe(false)
    expect(await readFile(join(first.path, 'marker.txt'), 'utf8')).toBe('created')
  })

  it('runs every hook phase', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    roots.push(root)
    const log = join(root, 'hooks.log')
    const manager = makeWorkspaceManager(
      root,
      hooks({
        afterCreate: `printf 'after_create\\n' >> '${log}'`,
        beforeRun: `printf 'before_run\\n' >> '${log}'`,
        afterRun: `printf 'after_run\\n' >> '${log}'`,
        beforeRemove: `printf 'before_remove\\n' >> '${log}'`,
      }),
    )

    const workspace = await Effect.runPromise(manager.create(issueIdentifier('GH-9')))
    await Effect.runPromise(manager.beforeRun(workspace))
    await Effect.runPromise(manager.afterRun(workspace))
    await Effect.runPromise(manager.remove(issueIdentifier('GH-9')))

    expect(await readFile(log, 'utf8')).toBe('after_create\nbefore_run\nafter_run\nbefore_remove\n')
  })

  it('drains large stdout and stderr without hanging', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    roots.push(root)
    const manager = makeWorkspaceManager(
      root,
      hooks({
        beforeRun:
          'node -e \'process.stdout.write("x".repeat(2_000_000)); process.stderr.write("y".repeat(2_000_000))\'',
      }),
    )
    const workspace = await Effect.runPromise(manager.create(issueIdentifier('GH-10')))

    await Effect.runPromise(manager.beforeRun(workspace))
  })

  it('returns bounded diagnostics for a nonzero exit', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    roots.push(root)
    const manager = makeWorkspaceManager(
      root,
      hooks({
        beforeRun:
          'node -e \'process.stdout.write("x".repeat(100_000)); process.stderr.write("y".repeat(100_000)); process.exitCode = 7\'',
      }),
    )
    const workspace = await Effect.runPromise(manager.create(issueIdentifier('GH-11')))

    const result = await Effect.runPromise(Effect.either(manager.beforeRun(workspace)))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.category).toBe('hook_failed')
      expect(result.left.message).toContain('code 7')
      expect(result.left.message).toContain('[output truncated]')
      expect(result.left.message.length).toBeLessThan(70_000)
    }
  })

  it('terminates signal-resistant grandchildren on timeout', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    roots.push(root)
    const manager = makeWorkspaceManager(
      root,
      hooks({
        beforeRun:
          'node -e \'process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync("timeout-leak", "x"), 800)\' & wait',
        timeoutMs: 100,
      }),
    )
    const workspace = await Effect.runPromise(manager.create(issueIdentifier('GH-12')))

    const result = await Effect.runPromise(Effect.either(manager.beforeRun(workspace)))
    await delay(900)

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.category).toBe('hook_timeout')
    }
    expect(await exists(join(workspace.path, 'timeout-leak'))).toBe(false)
  })

  it('terminates the hook process tree on cancellation', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    roots.push(root)
    const manager = makeWorkspaceManager(
      root,
      hooks({
        beforeRun:
          'node -e \'process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync("cancel-leak", "x"), 800)\' & wait',
      }),
    )
    const workspace = await Effect.runPromise(manager.create(issueIdentifier('GH-13')))
    const controller = new AbortController()
    const cancellation = setTimeout(() => controller.abort(), 100)

    await expect(
      Effect.runPromise(manager.beforeRun(workspace), { signal: controller.signal }),
    ).rejects.toThrow()
    clearTimeout(cancellation)
    await delay(900)

    expect(await exists(join(workspace.path, 'cancel-leak'))).toBe(false)
  })

  it('preserves fatal and best-effort hook behavior', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    roots.push(root)
    const createManager = makeWorkspaceManager(root, hooks({ afterCreate: 'exit 2' }))
    const createResult = await Effect.runPromise(
      Effect.either(createManager.create(issueIdentifier('GH-create-failure'))),
    )
    expect(createResult._tag).toBe('Left')

    const manager = makeWorkspaceManager(
      root,
      hooks({ beforeRun: 'exit 3', afterRun: 'exit 4', beforeRemove: 'exit 5' }),
    )
    const identifier = issueIdentifier('GH-14')
    const workspace = await Effect.runPromise(manager.create(identifier))
    const beforeRunResult = await Effect.runPromise(Effect.either(manager.beforeRun(workspace)))

    expect(beforeRunResult._tag).toBe('Left')
    await Effect.runPromise(manager.afterRun(workspace))
    await Effect.runPromise(manager.remove(identifier))
    expect(await exists(workspace.path)).toBe(false)
  })

  it('skips before_remove when the workspace does not exist', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    roots.push(root)
    const marker = join(root, 'unexpected-hook')
    const manager = makeWorkspaceManager(root, hooks({ beforeRemove: `touch '${marker}'` }))

    await Effect.runPromise(manager.remove(issueIdentifier('GH-missing')))

    expect(await exists(marker)).toBe(false)
  })

  it('skips before_remove when the workspace path is not a directory', async (): Promise<void> => {
    const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
    roots.push(root)
    const identifier = issueIdentifier('GH-not-a-directory')
    const path = containedWorkspacePath(root, workspaceKey(identifier))
    const marker = join(root, 'unexpected-file-hook')
    const manager = makeWorkspaceManager(root, hooks({ beforeRemove: `touch '${marker}'` }))
    await mkdir(root, { recursive: true })
    await writeFile(path, 'not a workspace')

    await Effect.runPromise(manager.remove(identifier))

    expect(await exists(marker)).toBe(false)
    expect(await exists(path)).toBe(false)
  })
})
