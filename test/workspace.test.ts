import { existsSync } from 'node:fs'
import { access, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Clock, Effect, Fiber } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { issueIdentifier, type Workspace } from '../src/domain/domain.js'
import type { HooksConfig } from '../src/config/workflow.js'
import { makeWorkspaceManager } from '../src/adapters/node/workspace-manager.js'
import { containedWorkspacePath, workspaceKey } from '../src/domain/workspace-containment.js'
import type { WorkspaceManagerPort } from '../src/ports/workspace.js'
import { hostFileSystem } from './harness/filesystem.js'
import { processIsAlive } from './harness/processes.js'

/**
 * The manager is built against the host filesystem, the way the composition root builds it. It
 * takes the filesystem from the layer, so building it is an effect; the tests are effects too, so
 * the port is acquired in the same fiber that uses it rather than run out to a value here.
 */
const workspaceManager = (root: string, hooks: HooksConfig): Effect.Effect<WorkspaceManagerPort> =>
  makeWorkspaceManager(root, hooks).pipe(Effect.provide(hostFileSystem))

/** Lifts one of the host filesystem calls these fixtures need into the effect under test. */
const host = <Value>(work: () => Promise<Value>): Effect.Effect<Value> => Effect.promise(work)

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

  it.live('runs after_create once and reuses the directory', () =>
    Effect.gen(function* () {
      const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
      roots.push(root)
      const manager = yield* workspaceManager(root, {
        afterCreate: 'printf created > marker.txt',
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 5_000,
      })

      const first = yield* manager.create(issueIdentifier('GH-8'))
      const second = yield* manager.create(issueIdentifier('GH-8'))

      expect(first.createdNow).toBe(true)
      expect(second.createdNow).toBe(false)
      expect(yield* host(() => readFile(join(first.path, 'marker.txt'), 'utf8'))).toBe('created')
    }),
  )
})

/**
 * Polls the host for a condition a hook's own process tree reaches on its own schedule.
 *
 * Deadline and wait both run on the fiber's own clock rather than the ambient one, so a case that
 * drives `TestClock` sees the poll move with it instead of quietly falling back to wall time.
 * Every caller is `it.live`, where that clock is the wall clock — which is what waiting on a real
 * process needs.
 */
const waitFor = (predicate: () => boolean, timeoutMs = 10_000): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (predicate()) {
        return true
      }
      yield* Effect.sleep(25)
    }
    return predicate()
  })

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
  it.live('drains a hook that writes far more than the capture limit', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(
        root,
        hooks({ afterCreate: `head -c 400000 /dev/zero | tr '\\0' 'a'` }),
      )

      const workspace = yield* manager.create(issueIdentifier('GH-100'))

      expect(workspace.createdNow).toBe(true)
    }),
  )

  it.live('truncates captured diagnostics in a hook failure', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(
        root,
        hooks({ afterCreate: `head -c 400000 /dev/zero | tr '\\0' 'b' >&2; exit 3` }),
      )

      const error = yield* Effect.flip(manager.create(issueIdentifier('GH-101')))

      expect(error.category).toBe('hook_failed')
      expect(error.message).toContain('exited with 3')
      expect(error.message).toContain('(truncated)')
      expect(error.message.length).toBeLessThan(2_000)
    }),
  )

  it.live('reports a nonzero exit with the hook phase', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      yield* (yield* workspaceManager(root, hooks())).create(issueIdentifier('GH-102'))
      const manager = yield* workspaceManager(root, hooks({ beforeRun: 'echo "boom" >&2; exit 7' }))

      const error = yield* Effect.flip(manager.beforeRun(workspaceFor(root, 'GH-102')))

      expect(error.category).toBe('hook_failed')
      expect(error.message).toContain('before_run hook exited with 7')
      expect(error.message).toContain('boom')
    }),
  )

  it.live('terminates the whole hook process tree on timeout', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      yield* (yield* workspaceManager(root, hooks())).create(issueIdentifier('GH-103'))
      const workspace = workspaceFor(root, 'GH-103')
      const manager = yield* workspaceManager(
        root,
        hooks({
          beforeRun: 'sleep 120 & echo $! > grandchild.pid; wait',
          timeoutMs: 250,
        }),
      )

      const error = yield* Effect.flip(manager.beforeRun(workspace))
      const grandchild = Number(
        (yield* host(() => readFile(join(workspace.path, 'grandchild.pid'), 'utf8'))).trim(),
      )

      expect(error.category).toBe('hook_timeout')
      expect(Number.isSafeInteger(grandchild)).toBe(true)
      expect(yield* waitFor(() => !processIsAlive(grandchild))).toBe(true)
    }),
  )

  it.live(
    'still forces termination when a descendant ignores SIGTERM after the shell closes',
    () =>
      Effect.gen(function* () {
        const root = makeRoot()
        yield* (yield* workspaceManager(root, hooks())).create(issueIdentifier('GH-109'))
        const workspace = workspaceFor(root, 'GH-109')
        const manager = yield* workspaceManager(
          root,
          hooks({
            // The descendant redirects its inherited pipes, so the shell's `close` fires while the
            // process group is still alive.
            beforeRun: `sh -c 'trap "" TERM; sleep 300' >/dev/null 2>&1 & echo $! > grandchild.pid; wait`,
            timeoutMs: 250,
          }),
        )

        const error = yield* Effect.flip(manager.beforeRun(workspace))
        const grandchild = Number(
          (yield* host(() => readFile(join(workspace.path, 'grandchild.pid'), 'utf8'))).trim(),
        )

        expect(error.category).toBe('hook_timeout')
        expect(grandchild).toBeGreaterThan(0)
        expect(yield* waitFor(() => !processIsAlive(grandchild), 20_000)).toBe(true)
      }),
    40_000,
  )

  it.live('terminates the hook process tree when the effect is interrupted', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      yield* (yield* workspaceManager(root, hooks())).create(issueIdentifier('GH-104'))
      const workspace = workspaceFor(root, 'GH-104')
      const manager = yield* workspaceManager(
        root,
        hooks({ beforeRun: 'sleep 120 & echo $! > grandchild.pid; wait' }),
      )

      const fiber = Effect.runFork(manager.beforeRun(workspace))
      yield* waitFor(() => existsSync(join(workspace.path, 'grandchild.pid')))
      const grandchild = Number(
        (yield* host(() => readFile(join(workspace.path, 'grandchild.pid'), 'utf8'))).trim(),
      )
      yield* Fiber.interrupt(fiber)

      expect(Number.isSafeInteger(grandchild)).toBe(true)
      expect(yield* waitFor(() => !processIsAlive(grandchild))).toBe(true)
    }),
  )
})

describe('hook phase semantics', (): void => {
  it.live('treats after_create as fatal for the workspace', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks({ afterCreate: 'exit 1' }))

      const error = yield* Effect.flip(manager.create(issueIdentifier('GH-105')))

      expect(error.category).toBe('hook_failed')
      expect(error.message).toContain('after_create')
    }),
  )

  it.live('treats after_run as best effort', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      yield* (yield* workspaceManager(root, hooks())).create(issueIdentifier('GH-106'))
      const manager = yield* workspaceManager(root, hooks({ afterRun: 'exit 1' }))

      expect(yield* manager.afterRun(workspaceFor(root, 'GH-106'))).toBeUndefined()
    }),
  )

  it.live('removes the workspace even when before_remove fails', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const created = yield* (yield* workspaceManager(root, hooks())).create(
        issueIdentifier('GH-107'),
      )
      const manager = yield* workspaceManager(root, hooks({ beforeRemove: 'exit 1' }))

      yield* manager.remove(issueIdentifier('GH-107'))

      expect(existsSync(created.path)).toBe(false)
    }),
  )

  it.live('runs before_remove only when the workspace directory exists', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const marker = join(root, 'before-remove-ran')
      const manager = yield* workspaceManager(
        root,
        hooks({ beforeRemove: `printf ran > ${JSON.stringify(marker)}` }),
      )

      yield* manager.remove(issueIdentifier('GH-108'))
      expect(existsSync(marker)).toBe(false)

      yield* (yield* workspaceManager(root, hooks())).create(issueIdentifier('GH-108'))
      yield* manager.remove(issueIdentifier('GH-108'))
      expect(existsSync(marker)).toBe(true)
    }),
  )
})

describe('workspace inspection and cleanup', (): void => {
  it.live('removes a missing workspace without running before_remove', () =>
    Effect.gen(function* () {
      const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
      roots.push(root)
      const manager = yield* workspaceManager(root, {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: 'touch hook-ran',
        timeoutMs: 5_000,
      })

      yield* manager.remove(issueIdentifier('GH-9'))

      yield* host(() => expect(access(root)).rejects.toThrow())
    }),
  )

  it.live('reports whether a contained workspace exists', () =>
    Effect.gen(function* () {
      const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
      roots.push(root)
      const manager = yield* workspaceManager(root, {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 5_000,
      })
      const identifier = issueIdentifier('GH-11')

      expect(yield* manager.exists(identifier)).toBe(false)
      yield* manager.create(identifier)
      expect(yield* manager.exists(identifier)).toBe(true)
    }),
  )

  it.live('rejects symlinked workspaces before running removal hooks', () =>
    Effect.gen(function* () {
      const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
      const outside = join('/tmp', `symphony-outside-${crypto.randomUUID()}`)
      roots.push(root, outside)
      yield* host(() => mkdir(root))
      yield* host(() => mkdir(outside))
      const identifier = issueIdentifier('GH-12')
      yield* host(() => symlink(outside, join(root, workspaceKey(identifier)), 'dir'))
      const manager = yield* workspaceManager(root, {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: 'touch hook-ran',
        timeoutMs: 5_000,
      })

      // `Effect.flip` already fails the test if either call succeeds; the tag says which
      // refusal the containment check produced.
      expect((yield* Effect.flip(manager.exists(identifier)))._tag).toBe('WorkspaceError')
      expect((yield* Effect.flip(manager.remove(identifier)))._tag).toBe('WorkspaceError')
      yield* host(() => expect(access(join(outside, 'hook-ran'))).rejects.toThrow())
    }),
  )

  it.live('logs and ignores before_remove failure while deleting the workspace', () =>
    Effect.gen(function* () {
      const root = join('/tmp', `symphony-workspace-${crypto.randomUUID()}`)
      roots.push(root)
      const manager = yield* workspaceManager(root, {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: 'exit 7',
        timeoutMs: 5_000,
      })
      const workspace = yield* manager.create(issueIdentifier('GH-10'))

      yield* manager.remove(issueIdentifier('GH-10'))

      yield* host(() => expect(access(workspace.path)).rejects.toThrow())
    }),
  )
})
