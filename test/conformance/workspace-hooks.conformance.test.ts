import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { issueIdentifier } from '../../src/domain.js'
import type { HooksConfig } from '../../src/workflow.js'
import { makeWorkspaceManager } from '../../src/workspace.js'

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

describe('Core Conformance workspace hook lifecycle', (): void => {
  it('aborts an attempt when before_run fails or times out', async (): Promise<void> => {
    const root = await makeRoot()
    const identifier = issueIdentifier('owner/repository#19')
    const failed = makeWorkspaceManager(root, hooks({ beforeRun: 'exit 7' }))
    const failedWorkspace = await Effect.runPromise(failed.create(identifier))
    await expect(Effect.runPromise(failed.beforeRun(failedWorkspace))).rejects.toThrow(
      'hook exited with 7',
    )

    const timedOut = makeWorkspaceManager(root, hooks({ beforeRun: 'sleep 1', timeoutMs: 20 }))
    const reused = await Effect.runPromise(timedOut.create(identifier))
    await expect(Effect.runPromise(timedOut.beforeRun(reused))).rejects.toThrow('hook timed out')
  })

  it('ignores after_run and before_remove failures while completing lifecycle', async (): Promise<void> => {
    const root = await makeRoot()
    const identifier = issueIdentifier('owner/repository#20')
    const manager = makeWorkspaceManager(
      root,
      hooks({ afterRun: 'exit 8', beforeRemove: 'exit 9' }),
    )
    const workspace = await Effect.runPromise(manager.create(identifier))
    await Effect.runPromise(manager.afterRun(workspace))
    await Effect.runPromise(manager.remove(identifier))
    await expect(access(workspace.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
