import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { issueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import type { HooksConfig } from '@sloppenheimer/core/config/workflow.js'
import { makeWorkspaceManager } from '@sloppenheimer/adapter-node/workspace-manager.js'
import type { WorkspaceManagerPort } from '@sloppenheimer/core/ports/workspace.js'
import { hostFileSystem } from '../harness/filesystem.js'
import { leaseLifetimeFloorMs } from '@sloppenheimer/core/domain/workspace-lease.js'

/**
 * Built against the host filesystem, the way the composition root builds it. Returned as an
 * effect rather than run here: the tests are effects now, so the port is acquired in the same
 * fiber that uses it.
 */
const workspaceManager = (root: string, hooks: HooksConfig): Effect.Effect<WorkspaceManagerPort> =>
  makeWorkspaceManager(root, hooks).pipe(Effect.provide(hostFileSystem))

const directories: string[] = []
const makeRoot = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppenheimer-hooks-conformance-'))
  directories.push(directory)
  return directory
}

afterEach(async (): Promise<void> => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

const hooks = (overrides: Partial<HooksConfig>): HooksConfig => ({
  afterCreate: null,
  beforeRun: null,
  afterRun: null,
  beforeRemove: null,
  timeoutMs: 2_000,
  ...overrides,
})

// `live` throughout: these hooks are real child processes on real timers, so the suite needs the
// wall clock rather than the virtual one `it.effect` installs.
// `live` throughout: these hooks are real child processes on real timers, so the suite needs the
// wall clock rather than the virtual one `it.effect` installs.
describe('Core Conformance workspace hook lifecycle', (): void => {
  it.live('aborts an attempt when before_run fails or times out', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeRoot)
      const identifier = issueIdentifier('owner/repository#19')
      const failed = yield* workspaceManager(root, hooks({ beforeRun: 'exit 7' }))
      // The hooks a run's workspace brackets are exercised inside the lease that holds it, which
      // is the only way the port hands one out.
      const rejected = yield* failed.withLeasedWorkspace(
        { identifier, runId: 1, lifetimeMs: leaseLifetimeFloorMs },
        (workspace) => Effect.flip(failed.beforeRun(workspace)),
        () => ({ _tag: 'Retained', reason: 'before_run failed' }),
      )
      expect(rejected.message).toContain('hook exited with 7')

      const timedOut = yield* workspaceManager(root, hooks({ beforeRun: 'sleep 1', timeoutMs: 20 }))
      const expired = yield* timedOut.withLeasedWorkspace(
        { identifier, runId: 2, lifetimeMs: leaseLifetimeFloorMs },
        (workspace) => Effect.flip(timedOut.beforeRun(workspace)),
        () => ({ _tag: 'Retained', reason: 'before_run timed out' }),
      )
      expect(expired.message).toContain('hook timed out')
    }),
  )

  it.live('ignores after_run and before_remove failures while completing lifecycle', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeRoot)
      const identifier = issueIdentifier('owner/repository#20')
      const manager = yield* workspaceManager(
        root,
        hooks({ afterRun: 'exit 8', beforeRemove: 'exit 9' }),
      )
      // The run releases its lease when its use ends: an issue's workspaces are removable only
      // once no live run holds one.
      const workspace = yield* manager.withLeasedWorkspace(
        { identifier, runId: 1, lifetimeMs: leaseLifetimeFloorMs },
        (leased) => Effect.as(manager.afterRun(leased), leased),
        () => ({ _tag: 'Retained', reason: 'run failed' }),
      )
      yield* manager.remove(identifier)
      yield* Effect.promise(() =>
        expect(access(workspace.path)).rejects.toMatchObject({ code: 'ENOENT' }),
      )
    }),
  )
})
