import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { issueIdentifier } from '@symphony/core/domain/domain.js'
import type { HooksConfig } from '@symphony/core/config/workflow.js'
import { makeWorkspaceManager } from '@symphony/adapter-node/workspace-manager.js'
import type { WorkspaceManagerPort } from '@symphony/core/ports/workspace.js'
import { hostFileSystem } from '../harness/filesystem.js'

/**
 * Built against the host filesystem, the way the composition root builds it. Returned as an
 * effect rather than run here: the tests are effects now, so the port is acquired in the same
 * fiber that uses it.
 */
const workspaceManager = (root: string, hooks: HooksConfig): Effect.Effect<WorkspaceManagerPort> =>
  makeWorkspaceManager(root, hooks).pipe(Effect.provide(hostFileSystem))

const directories: string[] = []
const makeRoot = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'symphony-hooks-conformance-'))
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
      const failedWorkspace = yield* failed.create(identifier)
      const rejected = yield* Effect.flip(failed.beforeRun(failedWorkspace))
      expect(rejected.message).toContain('hook exited with 7')

      const timedOut = yield* workspaceManager(root, hooks({ beforeRun: 'sleep 1', timeoutMs: 20 }))
      const reused = yield* timedOut.create(identifier)
      const expired = yield* Effect.flip(timedOut.beforeRun(reused))
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
      const workspace = yield* manager.create(identifier)
      yield* manager.afterRun(workspace)
      yield* manager.remove(identifier)
      yield* Effect.promise(() =>
        expect(access(workspace.path)).rejects.toMatchObject({ code: 'ENOENT' }),
      )
    }),
  )
})
