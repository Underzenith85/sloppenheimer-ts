import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { FileSystem } from '@effect/platform'
import { it } from '@effect/vitest'
import { Cause, Clock, Effect, Either, Exit, Fiber, Option, Ref } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { issueIdentifier, type Workspace } from '@sloppenheimer/core/domain/domain.js'
import type { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import type { HooksConfig } from '@sloppenheimer/core/config/workflow.js'
import { removeDirectoryIfEmpty } from '@sloppenheimer/adapter-node/filesystem.js'
import {
  hostOwner,
  renewLease,
  sayClaimStands,
} from '@sloppenheimer/adapter-node/workspace-lease.js'
import { makeWorkspaceManager } from '@sloppenheimer/adapter-node/workspace-manager.js'
import {
  containedRunWorkspacePath,
  containedWorkspacePath,
  workspaceKey,
} from '@sloppenheimer/core/domain/workspace-containment.js'
import {
  encodeLease,
  heldLease,
  leaseValidityMs,
  type WorkspaceLeaseRecord,
} from '@sloppenheimer/core/domain/workspace-lease.js'
import type { WorkspaceManagerPort } from '@sloppenheimer/core/ports/workspace.js'
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
    expect(Either.isLeft(containedWorkspacePath('/tmp/sloppenheimer-root', '..'))).toBe(true)
    expect(Either.isLeft(containedWorkspacePath('/tmp/sloppenheimer-root', '.'))).toBe(true)
  })

  it.live('runs after_create for every run workspace rather than reusing one directory', () =>
    Effect.gen(function* () {
      const root = join('/tmp', `sloppenheimer-workspace-${crypto.randomUUID()}`)
      roots.push(root)
      const manager = yield* workspaceManager(root, {
        afterCreate: 'printf created > marker.txt',
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 5_000,
      })

      const first = yield* retained(manager, 'GH-8', 1)
      const second = yield* retained(manager, 'GH-8', 2)

      expect(second.path).not.toBe(first.path)
      expect(yield* host(() => readFile(join(first.path, 'marker.txt'), 'utf8'))).toBe('created')
      expect(yield* host(() => readFile(join(second.path, 'marker.txt'), 'utf8'))).toBe('created')
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

/**
 * What a timing-sensitive hook test allows a hook to reach its first command in. The tests below
 * time a hook out on purpose, and each reads a file the hook's shell writes before it blocks: a
 * deadline that a loaded CI runner's `bash -lc` startup can outrun would kill the shell before it
 * wrote anything, so the deadline is generous while staying far shorter than the sleep it cuts.
 */
const hookStartupAllowanceMs = 3_000

const makeRoot = (): string => {
  const root = join('/tmp', `sloppenheimer-hooks-${crypto.randomUUID()}`)
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

/**
 * One run's workspace, kept when the run ends: the port hands a workspace out only for the length
 * of a use, so a test that wants a directory to look at afterwards asks for it to be retained. Two
 * of them means two run numbers, never one path a test computed for itself.
 */
const retained = (
  manager: WorkspaceManagerPort,
  identifier: string,
  runId = 1,
): Effect.Effect<Workspace, WorkspaceError> =>
  manager.withLeasedWorkspace(
    { identifier: issueIdentifier(identifier), runId },
    (workspace) => Effect.succeed(workspace),
    () => ({ _tag: 'Retained', reason: 'the run ended without publishing' }),
  )

/** The same, released as a run that published its work releases: with nothing left behind. */
const published = (
  manager: WorkspaceManagerPort,
  identifier: string,
  runId = 1,
): Effect.Effect<Workspace, WorkspaceError> =>
  manager.withLeasedWorkspace(
    { identifier: issueIdentifier(identifier), runId },
    (workspace) => Effect.succeed(workspace),
    () => ({ _tag: 'Completed' }),
  )

/** Runs `use` while the run still holds its lease, and keeps the workspace afterwards. */
const whileLeased = <Value, Failure>(
  manager: WorkspaceManagerPort,
  identifier: string,
  runId: number,
  use: (workspace: Workspace) => Effect.Effect<Value, Failure>,
): Effect.Effect<Value, Failure | WorkspaceError> =>
  manager.withLeasedWorkspace({ identifier: issueIdentifier(identifier), runId }, use, () => ({
    _tag: 'Retained',
    reason: 'the run ended without publishing',
  }))

describe('hook process hardening', (): void => {
  it.live('drains a hook that writes far more than the capture limit', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(
        root,
        hooks({ afterCreate: `head -c 400000 /dev/zero | tr '\\0' 'a'` }),
      )

      const workspace = yield* retained(manager, 'GH-100')

      expect(existsSync(workspace.path)).toBe(true)
    }),
  )

  it.live('truncates captured diagnostics in a hook failure', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(
        root,
        hooks({ afterCreate: `head -c 400000 /dev/zero | tr '\\0' 'b' >&2; exit 3` }),
      )

      const error = yield* Effect.flip(retained(manager, 'GH-101'))

      expect(error.category).toBe('hook_failed')
      expect(error.message).toContain('exited with 3')
      expect(error.message).toContain('(truncated)')
      expect(error.message.length).toBeLessThan(2_000)
    }),
  )

  it.live('reports a nonzero exit with the hook phase', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const workspace = yield* retained(yield* workspaceManager(root, hooks()), 'GH-102')
      const manager = yield* workspaceManager(root, hooks({ beforeRun: 'echo "boom" >&2; exit 7' }))

      const error = yield* Effect.flip(manager.beforeRun(workspace))

      expect(error.category).toBe('hook_failed')
      expect(error.message).toContain('before_run hook exited with 7')
      expect(error.message).toContain('boom')
    }),
  )

  it.live('terminates the whole hook process tree on timeout', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const workspace = yield* retained(yield* workspaceManager(root, hooks()), 'GH-103')
      const manager = yield* workspaceManager(
        root,
        hooks({
          beforeRun: 'sleep 120 & echo $! > grandchild.pid; wait',
          // Long enough that a loaded runner still starts `bash -lc` and records the grandchild
          // before the deadline, and still a fraction of the `sleep` the timeout has to cut short.
          timeoutMs: hookStartupAllowanceMs,
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
        const workspace = yield* retained(yield* workspaceManager(root, hooks()), 'GH-109')
        const manager = yield* workspaceManager(
          root,
          hooks({
            // The descendant redirects its inherited pipes, so the shell's `close` fires while the
            // process group is still alive.
            beforeRun: `sh -c 'trap "" TERM; sleep 300' >/dev/null 2>&1 & echo $! > grandchild.pid; wait`,
            timeoutMs: hookStartupAllowanceMs,
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
      const workspace = yield* retained(yield* workspaceManager(root, hooks()), 'GH-104')
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

      const error = yield* Effect.flip(retained(manager, 'GH-105'))

      expect(error.category).toBe('hook_failed')
      expect(error.message).toContain('after_create')
    }),
  )

  it.live('treats after_run as best effort', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const workspace = yield* retained(yield* workspaceManager(root, hooks()), 'GH-106')
      const manager = yield* workspaceManager(root, hooks({ afterRun: 'exit 1' }))

      expect(yield* manager.afterRun(workspace)).toBeUndefined()
    }),
  )

  it.live('removes the workspace even when before_remove fails', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const created = yield* retained(yield* workspaceManager(root, hooks()), 'GH-107')
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

      yield* retained(yield* workspaceManager(root, hooks()), 'GH-108')
      yield* manager.remove(issueIdentifier('GH-108'))
      expect(existsSync(marker)).toBe(true)
    }),
  )
})

describe('workspace inspection and cleanup', (): void => {
  it.live('removes a missing workspace without running before_remove', () =>
    Effect.gen(function* () {
      const root = join('/tmp', `sloppenheimer-workspace-${crypto.randomUUID()}`)
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
      const root = join('/tmp', `sloppenheimer-workspace-${crypto.randomUUID()}`)
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
      yield* retained(manager, 'GH-11')
      expect(yield* manager.exists(identifier)).toBe(true)
    }),
  )

  it.live('rejects symlinked workspaces before running removal hooks', () =>
    Effect.gen(function* () {
      const root = join('/tmp', `sloppenheimer-workspace-${crypto.randomUUID()}`)
      const outside = join('/tmp', `sloppenheimer-outside-${crypto.randomUUID()}`)
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
      const root = join('/tmp', `sloppenheimer-workspace-${crypto.randomUUID()}`)
      roots.push(root)
      const manager = yield* workspaceManager(root, {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: 'exit 7',
        timeoutMs: 5_000,
      })
      const workspace = yield* retained(manager, 'GH-10')

      yield* manager.remove(issueIdentifier('GH-10'))

      yield* host(() => expect(access(workspace.path)).rejects.toThrow())
    }),
  )
})

/** The pid of a process that has certainly exited: the owner a crashed host left behind. */
const exitedProcessId = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  if (child.pid === undefined) {
    throw new Error('the fixture process did not report a pid')
  }
  return child.pid
}

/**
 * A run workspace left on disk by another host, with the lease record that host would have
 * written. Nothing in the manager may adopt it: the test writes it exactly as a crashed or
 * concurrent host would.
 */
const foreignWorkspace = async (
  root: string,
  identifier: string,
  owner: WorkspaceLeaseRecord['owner'],
  acquiredAt = new Date(),
): Promise<string> => {
  const runKey = 'run-9-previoushost'
  const path = join(root, workspaceKey(issueIdentifier(identifier)), runKey)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'unpublished.txt'), 'work the host never pushed\n')
  await writeFile(
    `${path}.lease`,
    encodeLease(
      heldLease({ identifier: issueIdentifier(identifier), runId: 9 }, runKey, owner, acquiredAt),
    ),
  )
  // When the record was last written, which is what a second host reads rather than the expiry the
  // owner wrote into it: the two hosts share the filesystem's clock and nothing else.
  await utimes(`${path}.lease`, acquiredAt, acquiredAt)
  return path
}

/**
 * A lease another host published for a run whose directory has not appeared yet — the instant
 * between the two writes of an acquisition elsewhere.
 */
const foreignLease = async (
  root: string,
  identifier: string,
  owner: WorkspaceLeaseRecord['owner'],
): Promise<string> => {
  const runKey = 'run-4-acquiringhost'
  const path = join(root, workspaceKey(issueIdentifier(identifier)), runKey)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    `${path}.lease`,
    encodeLease(
      heldLease({ identifier: issueIdentifier(identifier), runId: 4 }, runKey, owner, new Date()),
    ),
  )
  return path
}

/** The lease record beside a run workspace, as cleanup and recovery read it. */
const leaseOf = async (workspacePath: string): Promise<WorkspaceLeaseRecord> =>
  JSON.parse(await readFile(`${workspacePath}.lease`, 'utf8')) as WorkspaceLeaseRecord

describe('run workspace allocation and leases', (): void => {
  it.live('allocates four concurrent runs four isolated directories', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())
      // Two attempts of one issue and two of another, all live at once: the rule is that no two
      // runs share a directory, not merely that no two issues do.
      const runs = [
        { identifier: 'GH-166', runId: 1 },
        { identifier: 'GH-166', runId: 2 },
        { identifier: 'GH-167', runId: 3 },
        { identifier: 'GH-167', runId: 4 },
      ]
      let written = 0

      const paths = yield* Effect.all(
        runs.map((run, index) =>
          whileLeased(manager, run.identifier, run.runId, (workspace) =>
            Effect.gen(function* () {
              yield* host(() => writeFile(join(workspace.path, 'work.txt'), `run-${String(index)}`))
              written += 1
              // Nobody looks until all four are holding their own workspace, so what each one then
              // reads is what it holds while the other three hold theirs.
              yield* waitFor(() => written === 4)
              expect(yield* host(() => readdir(workspace.path))).toEqual(['work.txt'])
              expect(yield* host(() => readFile(join(workspace.path, 'work.txt'), 'utf8'))).toBe(
                `run-${String(index)}`,
              )
              return workspace.path
            }),
          ),
        ),
        { concurrency: 'unbounded' },
      )

      const inodes = yield* host(() =>
        Promise.all(paths.map(async (path) => (await stat(path)).ino)),
      )
      // Distinct paths are not enough on their own: four names can be four links to one directory,
      // and it is the directory the agent's git metadata and worktree live in.
      expect(new Set(paths).size).toBe(4)
      expect(new Set(inodes).size).toBe(4)
      for (const path of paths) {
        expect(path.startsWith(`${root}/`)).toBe(true)
      }
    }),
  )

  it.live('refuses a second acquisition of one run identity before anything is launched', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())

      const refused = yield* whileLeased(manager, 'GH-168', 7, () =>
        Effect.flip(published(manager, 'GH-168', 7)),
      )

      expect(refused.category).toBe('lease_conflict')
    }),
  )

  it.live('takes away staged records no writer can still be holding', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const staging = join(root, '#lease-writes')
      yield* host(() => mkdir(staging, { recursive: true }))
      const record = encodeLease(
        heldLease(
          { identifier: issueIdentifier('GH-183'), runId: 1 },
          'run-1-hosta',
          hostOwner,
          new Date(),
        ),
      )
      const abandoned = join(staging, `${crypto.randomUUID()}.lease`)
      const inFlight = join(staging, `${crypto.randomUUID()}.lease`)
      const somebodyElses = join(staging, `${crypto.randomUUID()}.lease`)
      const notOurName = join(staging, 'notes.txt')
      yield* host(() => writeFile(abandoned, record))
      yield* host(() => writeFile(inFlight, record))
      yield* host(() => writeFile(somebodyElses, 'a file that is not a lease record'))
      yield* host(() => writeFile(notOurName, record))
      const longAgo = new Date(Date.now() - 4 * 60 * 60 * 1_000)
      yield* Effect.all(
        [abandoned, somebodyElses, notOurName].map((path) =>
          host(() => utimes(path, longAgo, longAgo)),
        ),
      )

      // Building a manager is what sweeps them: once at startup, and again on every reload.
      yield* workspaceManager(root, hooks())

      // Staging is a single write, so an old record belongs to a host that was killed between
      // writing one and publishing it. Anything recent may still be on its way — and the sweep
      // unlinks by pathname, so it removes only what it can show is a record it wrote itself.
      expect(existsSync(abandoned)).toBe(false)
      expect(existsSync(inFlight)).toBe(true)
      expect(existsSync(somebodyElses)).toBe(true)
      expect(existsSync(notOurName)).toBe(true)
    }),
  )

  it.live('sweeps only plain records, never a link into somewhere else', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const outside = join('/tmp', `sloppenheimer-outside-${crypto.randomUUID()}`)
      roots.push(outside)
      yield* host(() => mkdir(outside))
      const bystander = join(outside, 'someone-elses.txt')
      yield* host(() => writeFile(bystander, 'not ours to sweep'))
      const staging = join(root, '#lease-writes')
      yield* host(() => mkdir(staging, { recursive: true }))
      const pointer = join(staging, 'pointer.lease')
      yield* host(() => symlink(bystander, pointer))
      const longAgo = new Date(Date.now() - 4 * 60 * 60 * 1_000)
      yield* host(() => utimes(bystander, longAgo, longAgo))

      yield* workspaceManager(root, hooks())

      // The sweep unlinks records, so it removes only what it has confirmed is a plain file: a
      // link is left where it is, and what it points at is never touched.
      expect(existsSync(pointer)).toBe(true)
      expect(existsSync(bystander)).toBe(true)
    }),
  )

  it.live('refuses a staging directory that is a substituted path', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const outside = join('/tmp', `sloppenheimer-outside-${crypto.randomUUID()}`)
      roots.push(outside)
      yield* host(() => mkdir(root, { recursive: true }))
      yield* host(() => mkdir(outside))
      const bystander = join(outside, 'someone-elses.txt')
      yield* host(() => writeFile(bystander, 'not ours to sweep'))
      const longAgo = new Date(Date.now() - 4 * 60 * 60 * 1_000)
      yield* host(() => utimes(bystander, longAgo, longAgo))
      yield* host(() => symlink(outside, join(root, '#lease-writes'), 'dir'))

      const manager = yield* workspaceManager(root, hooks())
      const refused = yield* Effect.flip(retained(manager, 'GH-182'))

      // The sweep deletes what it finds, and staging writes what a claim is made of: neither may
      // follow a link out of the configured root.
      expect(refused.category).toBe('invalid_path')
      expect(existsSync(bystander)).toBe(true)
    }),
  )

  it.live('stages lease records outside the issue directory cleanup reads', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks({ beforeRemove: 'exit 0' }))
      const identifier = issueIdentifier('GH-180')
      const workspace = yield* retained(manager, 'GH-180')
      // A record a host died before publishing. Cleanup reads an issue directory as run workspaces
      // and their leases, and would take a file like this for one of them.
      const abandonedWrite = join(root, '#lease-writes', 'abandoned.lease')
      yield* host(() => mkdir(dirname(abandonedWrite), { recursive: true }))
      yield* host(() => writeFile(abandonedWrite, 'half a record'))

      yield* manager.remove(identifier)

      expect(existsSync(workspace.path)).toBe(false)
      expect(yield* manager.exists(identifier)).toBe(false)
      expect(existsSync(abandonedWrite)).toBe(true)
    }),
  )

  it.live('leaves the winner of a refused claim holding its own lease', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())
      const identifier = issueIdentifier('GH-179')

      const workspace = yield* whileLeased(manager, 'GH-179', 7, (held) =>
        Effect.gen(function* () {
          const refused = yield* Effect.flip(published(manager, 'GH-179', 7))

          // The refusal is the second acquisition's own. The lease it could not take belongs to
          // the run holding it, and rewriting it would let cleanup take that run's live workspace.
          expect(refused.category).toBe('lease_conflict')
          expect(yield* host(() => leaseOf(held.path))).toMatchObject({
            status: 'held',
            reason: null,
          })
          yield* manager.remove(identifier)
          expect(existsSync(held.path)).toBe(true)
          return held
        }),
      )

      expect(existsSync(workspace.path)).toBe(true)
    }),
  )

  it.live('keeps a failed attempt as a named artifact and starts its retry clean', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())
      const identifier = issueIdentifier('GH-169')
      const first = yield* manager.withLeasedWorkspace(
        { identifier, runId: 1 },
        (workspace) =>
          host(() => writeFile(join(workspace.path, 'unpublished.txt'), 'in progress\n')).pipe(
            Effect.as(workspace),
          ),
        () => ({ _tag: 'Retained', reason: 'worker failed' }),
      )
      const second = yield* retained(manager, 'GH-169', 2)

      // The retry inherits nothing, and what the failed attempt holds is explained by its lease
      // rather than left for a later run to find and adopt.
      expect(second.path).not.toBe(first.path)
      expect(yield* host(() => readdir(second.path))).toEqual([])
      expect(yield* host(() => readdir(first.path))).toEqual(['unpublished.txt'])
      expect(yield* host(() => leaseOf(first.path))).toMatchObject({
        identifier,
        runId: 1,
        status: 'retained',
        reason: 'worker failed',
      })
    }),
  )

  it.live('takes the workspace of a run that published, and the issue directory with it', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())
      const identifier = issueIdentifier('GH-170')
      const workspace = yield* published(manager, 'GH-170')

      expect(existsSync(workspace.path)).toBe(false)
      expect(existsSync(`${workspace.path}.lease`)).toBe(false)
      expect(yield* manager.exists(identifier)).toBe(false)
    }),
  )

  it.live('cannot clean up a workspace a live run holds', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())
      const identifier = issueIdentifier('GH-171')
      const workspace = yield* whileLeased(manager, 'GH-171', 1, (held) =>
        Effect.gen(function* () {
          yield* manager.remove(identifier)
          expect(existsSync(held.path)).toBe(true)
          return held
        }),
      )

      yield* manager.remove(identifier)

      expect(existsSync(workspace.path)).toBe(false)
      expect(yield* manager.exists(identifier)).toBe(false)
    }),
  )

  it.live('leaves alone a lease published before its own directory exists', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())
      const identifier = 'GH-177'
      const acquiring = yield* host(() =>
        foreignLease(root, identifier, {
          hostId: 'a host acquiring right now',
          processId: process.pid,
          startMarker: hostOwner.startMarker,
          namespace: hostOwner.namespace,
        }),
      )

      yield* manager.remove(issueIdentifier(identifier))

      // An acquisition publishes its lease before it creates its directory, so cleanup that runs in
      // between finds the lease rather than a workspace it would read as belonging to nobody.
      expect(existsSync(`${acquiring}.lease`)).toBe(true)
    }),
  )

  it.live('leaves alone a lease whose owner belongs to another process namespace', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())
      const identifier = 'GH-178'
      // Two containers sharing a workspace root each see their own process ids: an id from the
      // other one names nothing here, and an owner it names is never concluded to be gone.
      const held = yield* host(async () =>
        foreignWorkspace(root, identifier, {
          hostId: 'a host in another container',
          processId: await exitedProcessId(),
          startMarker: 'a marker from another namespace',
          namespace: 'another kernel/pid:[4026531999]',
        }),
      )

      yield* manager.remove(issueIdentifier(identifier))

      expect(existsSync(held)).toBe(true)
    }),
  )

  it.live('says a lease still stands for as long as its run holds it', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      // A renewal every 50ms rather than every five minutes: the interval is the host's, and a
      // test that had to wait one would be measuring the clock rather than the renewal.
      const manager = yield* makeWorkspaceManager(root, hooks(), hostOwner, {
        intervalMs: 50,
      }).pipe(Effect.provide(hostFileSystem))
      const identifier = issueIdentifier('GH-185')

      const renewed = yield* manager.withLeasedWorkspace(
        { identifier, runId: 1 },
        (workspace) =>
          Effect.gen(function* () {
            const first = yield* host(() => leaseOf(workspace.path))
            yield* waitFor(
              () =>
                existsSync(`${workspace.path}.lease`) &&
                readFileSync(`${workspace.path}.lease`, 'utf8').includes('"expiresAt"') &&
                (
                  JSON.parse(
                    readFileSync(`${workspace.path}.lease`, 'utf8'),
                  ) as WorkspaceLeaseRecord
                ).expiresAt !== first.expiresAt,
              5_000,
            )
            return yield* host(() => leaseOf(workspace.path))
          }),
        () => ({ _tag: 'Retained', reason: 'the run ended without publishing' }),
      )

      // A host that cannot observe this one's process has nothing else to go on: the run saying so
      // is what keeps its workspace from being reclaimed under it. The record stands past the
      // window the claim itself bought, which only a renewal can have written.
      expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(
        Date.parse(renewed.acquiredAt) + leaseValidityMs,
      )
    }),
  )

  it.live('says so while its own provisioning hook is still working', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      // An `after_create` hook is the caller's own command and nothing bounds it: this one runs
      // far past the interval at which the run says its lease still stands, which on the host is
      // the difference between a five-minute hook and an hour-long one.
      const manager = yield* makeWorkspaceManager(
        root,
        hooks({ afterCreate: 'sleep 0.4' }),
        hostOwner,
        { intervalMs: 50 },
      ).pipe(Effect.provide(hostFileSystem))
      const identifier = issueIdentifier('GH-186')

      const lease = yield* manager.withLeasedWorkspace(
        { identifier, runId: 1 },
        (workspace) => host(() => leaseOf(workspace.path)),
        () => ({ _tag: 'Completed' }),
      )

      // The record stands well past the window the claim itself bought — past anything the say at
      // claim time could have written — so it was said again while the hook ran: a host that cannot
      // observe this one's process is never told the run is gone while provisioning is still going.
      expect(Date.parse(lease.expiresAt)).toBeGreaterThan(
        Date.parse(lease.acquiredAt) + leaseValidityMs + 200,
      )
      expect(lease.status).toBe('held')
    }),
  )

  it.live('takes the lease record before anything runs against the workspace', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      // The hook lists the issue directory it is being removed from, into the root, where cleanup
      // does not reach. Deciding a workspace is free and removing it are two steps, and this is the
      // one in between: a record still sitting there is a record a run could say again.
      const listing = join(root, 'issue-entries')
      const manager = yield* workspaceManager(
        root,
        hooks({ beforeRemove: `ls .. > ${JSON.stringify(listing)}` }),
      )
      const workspace = yield* retained(manager, 'GH-186')

      yield* manager.remove(issueIdentifier('GH-186'))

      const entries = readFileSync(listing, 'utf8').split('\n').filter(Boolean)
      expect(entries).toContain(workspace.key)
      expect(entries).not.toContain(`${workspace.key}.lease`)
      expect(existsSync(workspace.path)).toBe(false)
    }),
  )

  it.live('stops a run whose lease has been taken out from under it', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* makeWorkspaceManager(root, hooks(), hostOwner, {
        intervalMs: 50,
      }).pipe(Effect.provide(hostFileSystem))
      let taken = ''

      const outcome = yield* Effect.exit(
        manager.withLeasedWorkspace(
          { identifier: issueIdentifier('GH-187'), runId: 1 },
          (workspace) =>
            Effect.gen(function* () {
              taken = workspace.path
              // Exactly what cleanup does to a workspace it has decided is free. The run would
              // otherwise work on in a directory another host is already taking back.
              yield* host(() => rm(`${workspace.path}.lease`))
              yield* Effect.sleep(30_000)
            }),
          () => ({ _tag: 'Retained', reason: 'the run ended without publishing' }),
        ),
      )

      expect(Exit.isFailure(outcome)).toBe(true)
      const failure = Exit.isFailure(outcome)
        ? Cause.failureOption(outcome.cause)
        : Option.none<WorkspaceError>()
      expect(Option.getOrThrow(failure).category).toBe('lease_conflict')
      // And it lets go of what it no longer holds: a run that publishes a record here would be
      // naming a workspace whoever took the lease may already have removed.
      expect(existsSync(`${taken}.lease`)).toBe(false)
    }),
  )

  it.live('stops saying a lease stands once the window it knew about has run out', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const fileSystem = yield* FileSystem.FileSystem
      const paths = yield* containedRunWorkspacePath(
        root,
        issueIdentifier('GH-188'),
        'run-1-a-host',
      )
      // A record that cannot be read or written at all: renewals fail rather than answering. A
      // filesystem that is full, read-only, or unreachable is the case this stands in for.
      yield* host(() => mkdir(paths.leasePath, { recursive: true }))
      const run = { identifier: issueIdentifier('GH-188'), runId: 1 }

      // While the run still knows its lease stands, a renewal it cannot make is not a lease lost.
      const kept = yield* Effect.exit(
        renewLease(
          fileSystem,
          paths,
          run,
          hostOwner,
          10,
          yield* Ref.make(Date.now() + 60_000),
        ).pipe(Effect.timeout(200)),
      )
      const stillRenewing = Exit.isFailure(kept)
        ? Cause.failureOption(kept.cause)
        : Option.none<WorkspaceError>()
      expect(Option.getOrThrow(stillRenewing)._tag).toBe('TimeoutException')

      // Once that window has run out, another host is free to take the workspace, so the run stops.
      const lost = yield* Effect.exit(
        renewLease(fileSystem, paths, run, hostOwner, 10, yield* Ref.make(Date.now() - 1)),
      )
      const failure = Exit.isFailure(lost)
        ? Cause.failureOption(lost.cause)
        : Option.none<WorkspaceError>()
      expect(Option.getOrThrow(failure).category).toBe('lease_conflict')
    }).pipe(Effect.provide(hostFileSystem)),
  )

  it.live('says a lease again as soon as it is claimed, before anything is built on it', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const fileSystem = yield* FileSystem.FileSystem
      const runKey = 'run-1-a-host'
      const paths = yield* containedRunWorkspacePath(root, issueIdentifier('GH-190'), runKey)
      const run = { identifier: issueIdentifier('GH-190'), runId: 1 }
      // A claim published half an hour after it was written — a host stopped between staging the
      // record and linking it. The record still stands, but it reads as half spent, and a second
      // host reads its stamp rather than this one's word for it.
      const claimed = heldLease(run, runKey, hostOwner, new Date(Date.now() - leaseValidityMs / 2))
      yield* host(() => mkdir(paths.issuePath, { recursive: true }))
      yield* host(() => writeFile(paths.leasePath, encodeLease(claimed)))
      const standing = yield* Ref.make(Date.parse(claimed.expiresAt))

      yield* sayClaimStands(fileSystem, paths, run, hostOwner, standing)

      const said = yield* host(() => leaseOf(paths.runPath))
      expect(Date.parse(said.expiresAt)).toBeGreaterThan(Date.parse(claimed.expiresAt))
      expect(said.acquiredAt).toBe(claimed.acquiredAt)
      // And what the run believes moves with it, so the next renewal starts from the window it has.
      expect(yield* Ref.get(standing)).toBe(Date.parse(said.expiresAt))
    }).pipe(Effect.provide(hostFileSystem)),
  )

  it.live('refuses a claim it cannot say, where a renewal would have waited', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const fileSystem = yield* FileSystem.FileSystem
      const runKey = 'run-1-a-host'
      const paths = yield* containedRunWorkspacePath(root, issueIdentifier('GH-191'), runKey)
      const run = { identifier: issueIdentifier('GH-191'), runId: 1 }
      const claimed = heldLease(run, runKey, hostOwner, new Date())
      yield* host(() => mkdir(paths.issuePath, { recursive: true }))
      yield* host(() => writeFile(paths.leasePath, encodeLease(claimed)))
      // Nowhere to stage a record, so the write cannot land. A renewal would wait for the next one,
      // having a window still open; a claim has nothing to wait on but the stamp it arrived with.
      yield* host(() => writeFile(paths.stagingPath, 'not a directory\n'))
      const standing = yield* Ref.make(Date.parse(claimed.expiresAt))

      const refused = yield* Effect.exit(
        sayClaimStands(fileSystem, paths, run, hostOwner, standing),
      )

      expect(Exit.isFailure(refused)).toBe(true)
      expect(readFileSync(paths.leasePath, 'utf8')).toBe(encodeLease(claimed))
    }).pipe(Effect.provide(hostFileSystem)),
  )

  it.live('never says a lease again once it has expired', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const fileSystem = yield* FileSystem.FileSystem
      const runKey = 'run-1-a-host'
      const paths = yield* containedRunWorkspacePath(root, issueIdentifier('GH-189'), runKey)
      const run = { identifier: issueIdentifier('GH-189'), runId: 1 }
      // This host's own record, expired: another host is already free to take the workspace on the
      // strength of it, so writing it back would be taking it out from under whoever did.
      const expired = encodeLease(
        heldLease(run, runKey, hostOwner, new Date(Date.now() - 2 * leaseValidityMs)),
      )
      yield* host(() => mkdir(paths.issuePath, { recursive: true }))
      yield* host(() => writeFile(paths.leasePath, expired))

      const lost = yield* Effect.exit(
        renewLease(fileSystem, paths, run, hostOwner, 10, yield* Ref.make(Date.now() + 60_000)),
      )

      const failure = Exit.isFailure(lost)
        ? Cause.failureOption(lost.cause)
        : Option.none<WorkspaceError>()
      expect(Option.getOrThrow(failure).category).toBe('lease_conflict')
      expect(readFileSync(paths.leasePath, 'utf8')).toBe(expired)
    }).pipe(Effect.provide(hostFileSystem)),
  )

  it.live('reclaims an unobservable lease once no run could still be holding it', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())
      const identifier = 'GH-184'
      const abandoned = yield* host(() =>
        foreignWorkspace(
          root,
          identifier,
          {
            hostId: 'a host in another container',
            processId: process.pid,
            startMarker: 'a marker from another namespace',
            namespace: 'another kernel/pid:[4026531999]',
          },
          new Date(Date.now() - leaseValidityMs - 60_000),
        ),
      )

      yield* manager.remove(issueIdentifier(identifier))

      // Nothing here can observe that owner's process, and no run of any workflow is still going a
      // week later: age is what reclaims the workspaces a crashed host leaves on such a platform.
      expect(existsSync(abandoned)).toBe(false)
    }),
  )

  it.live('leaves a workspace a second live host still holds', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())
      const identifier = 'GH-173'
      const held = yield* host(() =>
        foreignWorkspace(root, identifier, {
          hostId: 'another live host',
          processId: process.pid,
          startMarker: hostOwner.startMarker,
          namespace: hostOwner.namespace,
        }),
      )

      yield* manager.remove(issueIdentifier(identifier))

      expect(existsSync(held)).toBe(true)
      expect(existsSync(`${held}.lease`)).toBe(true)
    }),
  )
})

/**
 * The two cases below turn on what this host can observe of another owner's process: the namespace
 * its ids belong to, and when the process behind one started. Both are read from `/proc`, so a host
 * that reports neither cannot run them, and they are reported as skipped rather than as a silent
 * pass. The rules they exercise are covered without a host in `test/domain/workspace-lease.test.ts`.
 */
const ownersAreObservable = hostOwner.namespace !== null && hostOwner.startMarker !== null

describe.skipIf(!ownersAreObservable)('reclaiming an owner this host can observe', (): void => {
  it.live('never enters a workspace a departed host left, and cleans it up afterwards', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())
      const identifier = 'GH-172'
      const abandoned = yield* host(async () =>
        foreignWorkspace(root, identifier, {
          hostId: 'a host that is gone',
          processId: await exitedProcessId(),
          startMarker: null,
          namespace: hostOwner.namespace,
        }),
      )

      // The run number a restarted host counts from starts again at one, so the workspace name
      // carries the host as well: this acquisition cannot land on the abandoned directory even
      // when it reuses that host's run number.
      const workspace = yield* published(
        manager,
        identifier,
        // The run number a restarted host counts from starts again at one, so this acquisition
        // deliberately reuses the departed host's own.
        9,
      )
      expect(workspace.path).not.toBe(abandoned)

      yield* manager.remove(issueIdentifier(identifier))

      // With its owner gone, the artifact is cleanup's to take once the issue is finished with.
      expect(existsSync(abandoned)).toBe(false)
    }),
  )

  it.live('terminates an after_create process tree when the acquisition is interrupted', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(
        root,
        // A timeout far longer than this test may take: what ends the hook has to be the
        // interruption itself, not the deadline.
        hooks({ afterCreate: 'sleep 120 & echo $! > grandchild.pid; wait', timeoutMs: 120_000 }),
      )
      const issuePath = join(root, workspaceKey(issueIdentifier('GH-181')))
      const pidFile = (): string | null => {
        const runs = existsSync(issuePath) ? readdirSync(issuePath) : []
        const found = runs
          .map((entry) => join(issuePath, entry, 'grandchild.pid'))
          .find((path) => existsSync(path))
        return found ?? null
      }

      const fiber = Effect.runFork(retained(manager, 'GH-181'))
      yield* waitFor(() => pidFile() !== null)
      const recorded = pidFile() ?? ''
      const grandchild = Number((yield* host(() => readFile(recorded, 'utf8'))).trim())
      const interruptedAt = yield* Clock.currentTimeMillis
      yield* Fiber.interrupt(fiber)
      const returnedAt = yield* Clock.currentTimeMillis

      // Only the claim is taken uninterruptibly: a cancellation during provisioning reaches the
      // hook's own process tree there and then, rather than waiting out its timeout.
      expect(returnedAt - interruptedAt).toBeLessThan(10_000)
      expect(Number.isSafeInteger(grandchild)).toBe(true)
      expect(yield* waitFor(() => !processIsAlive(grandchild))).toBe(true)
    }),
  )

  it.live('keeps the workspace of an acquisition whose provisioning hook failed', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks({ afterCreate: 'exit 1' }))
      const identifier = issueIdentifier('GH-174')

      const failed = yield* Effect.flip(published(manager, 'GH-174'))

      // The lease was taken before the hook ran, and a failed acquisition returns nothing for the
      // run to release with: the workspace has to be retained here, or cleanup could never take it.
      expect(failed.category).toBe('hook_failed')
      expect(yield* manager.exists(identifier)).toBe(true)
      yield* manager.remove(identifier)
      expect(yield* manager.exists(identifier)).toBe(false)
    }),
  )

  it.live('writes a lease record whole, leaving no partial file beside it', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())
      const identifier = issueIdentifier('GH-175')

      const workspace = yield* retained(manager, 'GH-175')

      // The record is published from outside the issue directory, so the only entries that
      // directory holds are its run workspaces and their finished leases.
      expect((yield* host(() => readdir(join(root, workspaceKey(identifier))))).toSorted()).toEqual(
        [workspace.key, `${workspace.key}.lease`].toSorted(),
      )
      expect(yield* host(() => leaseOf(workspace.path))).toMatchObject({
        status: 'retained',
        reason: 'the run ended without publishing',
      })
    }),
  )

  it.live('will not take an issue directory a workspace appeared in', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const directory = join(root, 'container')
      yield* host(() => mkdir(directory, { recursive: true }))

      expect(yield* removeDirectoryIfEmpty(directory)).toBe(true)

      yield* host(() => mkdir(join(directory, 'run-1-host'), { recursive: true }))

      // What cleanup removes at the end of its scan is the container, and only while it is still
      // empty: a run acquired while the scan was running must not go with it.
      expect(yield* removeDirectoryIfEmpty(directory)).toBe(false)
      expect(existsSync(join(directory, 'run-1-host'))).toBe(true)
    }),
  )

  it.live('reclaims a lease whose process id was handed to a later process', () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const manager = yield* workspaceManager(root, hooks())
      const identifier = 'GH-176'
      // This process is running under the recorded id, and is not the process that recorded it —
      // the ordinary shape of a host restarted into the same id, which a container's PID 1 is.
      const abandoned = yield* host(() =>
        foreignWorkspace(root, identifier, {
          hostId: 'a host that restarted into this id',
          processId: process.pid,
          startMarker: 'a process that is no longer here',
          namespace: hostOwner.namespace,
        }),
      )

      yield* manager.remove(issueIdentifier(identifier))

      expect(existsSync(abandoned)).toBe(false)
    }),
  )
})
