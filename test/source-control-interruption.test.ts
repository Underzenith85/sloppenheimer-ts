import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Fiber, Option, Redacted } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { makeGitSourceControl } from '@symphony/adapter-node/source-control.js'
import { SourceControlError } from '@symphony/core/domain/errors.js'
import { issueId, issueIdentifier, type Issue } from '@symphony/core/domain/domain.js'
import { commitFile, git, makeGitRepository } from './harness/git-repository.js'

const roots: string[] = []
const originalTmpDir = process.env['TMPDIR']

afterEach(async (): Promise<void> => {
  if (originalTmpDir === undefined) {
    delete process.env['TMPDIR']
  } else {
    process.env['TMPDIR'] = originalTmpDir
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

const issue: Issue = {
  id: issueId('185'),
  nativeRef: null,
  identifier: issueIdentifier('example/symphony#185'),
  title: 'Interruptible publication',
  description: null,
  priority: 1,
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

/** How long the remote hook blocks the push for, and how long the assertion outlives it. */
const blockedPushSeconds = 3
const outlivesBlockedPushMs = (blockedPushSeconds + 2) * 1_000
/** A NUL byte, which `spawn` refuses by throwing rather than by emitting `error`. */
const NUL = String.fromCharCode(0)
/** How long the merge driver blocks the rebase for. */
const blockedMergeSeconds = 60
const pollIntervalMs = 10
const waitLimitMs = 20_000

const waitFor = async (condition: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + waitLimitMs
  while (Date.now() < deadline) {
    if (await condition()) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error('condition was not met before the deadline')
}

const askPassDirectories = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(root)
  return entries.filter((entry) => entry.startsWith('symphony-git-askpass-'))
}

describe('host Git source control interruption', (): void => {
  it('removes the askpass directory and the git process group when a push is interrupted', async (): Promise<void> => {
    const fixture = await makeGitRepository()
    roots.push(fixture.root)
    // A private TMPDIR so the assertion sees only this test's askpass directories. `os.tmpdir()`
    // reads the environment on each call, so the adapter picks this up without being told.
    const temporary = await mkdtemp(join(tmpdir(), 'symphony-askpass-observation-'))
    roots.push(temporary)
    process.env['TMPDIR'] = temporary

    // `receive-pack` runs this on the remote, so the push blocks while every earlier git
    // invocation of the publication — status, commit, fetch, rebase, ls-remote — still succeeds.
    const started = join(fixture.root, 'push-started')
    const survived = join(fixture.root, 'push-survived')
    const hook = join(fixture.remote, 'hooks', 'pre-receive')
    await writeFile(
      hook,
      `#!/bin/sh\ntouch '${started}'\nsleep ${String(blockedPushSeconds)}\ntouch '${survived}'\nexit 1\n`,
      { mode: 0o755 },
    )
    await chmod(hook, 0o755)

    const sourceControl = makeGitSourceControl({
      remoteUrl: fixture.remote,
      baseBranch: 'main',
      credential: Option.some({ username: 'x-access-token', password: Redacted.make('secret') }),
    })
    const workspace = { path: fixture.workspace, key: 'issue-185', createdNow: true }
    const prepared = await Effect.runPromise(
      sourceControl.prepare(issue, workspace, {
        _tag: 'Normal',
        branchName: 'symphony/issue-185',
      }),
    )
    await writeFile(join(fixture.workspace, 'implementation.ts'), 'export const done = true\n')

    const fiber = Effect.runFork(sourceControl.publish(issue, prepared))
    await waitFor(async () => (await readdir(fixture.root)).includes('push-started'))
    expect(await askPassDirectories(temporary)).toHaveLength(1)

    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(await askPassDirectories(temporary)).toEqual([])
    // The blocked hook is a descendant of the interrupted git process group. A group that outlived
    // the interruption would run the hook to completion and leave its second sentinel behind.
    await new Promise<void>((resolve) => setTimeout(resolve, outlivesBlockedPushMs))
    await expect(readdir(fixture.root)).resolves.not.toContain('push-survived')
  }, 30_000)

  it('leaves no rebase state behind when a publication is interrupted mid-rebase', async (): Promise<void> => {
    const fixture = await makeGitRepository()
    roots.push(fixture.root)
    await commitFile(fixture.seed, 'conflict.ts', 'base\n', 'add the contested file')
    await git(fixture.seed, ['push', 'origin', 'main'])

    const sourceControl = makeGitSourceControl({
      remoteUrl: fixture.remote,
      baseBranch: 'main',
      credential: Option.none(),
    })
    const prepared = await Effect.runPromise(
      sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-185', createdNow: true },
        { _tag: 'Normal', branchName: 'symphony/issue-185' },
      ),
    )
    await writeFile(join(fixture.workspace, 'conflict.ts'), 'local\n')
    // Advances the protected base over the same file, so the rebase has a content conflict to
    // resolve and reaches the merge driver.
    await writeFile(join(fixture.seed, 'conflict.ts'), 'remote\n')
    await git(fixture.seed, ['commit', '--all', '--message', 'advance the contested file'])
    await git(fixture.seed, ['push', 'origin', 'main'])

    // A merge driver is the one point inside a rebase this test can hold open. It reports it has
    // started and then blocks, so the fiber is interrupted with the rebase genuinely in progress.
    const merging = join(fixture.root, 'merge-started')
    const driver = join(fixture.root, 'slow-merge.sh')
    await writeFile(
      driver,
      `#!/bin/sh\ntouch '${merging}'\nsleep ${String(blockedMergeSeconds)}\nexit 1\n`,
      { mode: 0o755 },
    )
    await chmod(driver, 0o755)
    await writeFile(
      join(fixture.workspace, '.git', 'info', 'attributes'),
      'conflict.ts merge=slow\n',
    )
    await git(fixture.workspace, ['config', 'merge.slow.name', 'blocks until interrupted'])
    await git(fixture.workspace, ['config', 'merge.slow.driver', `'${driver}' %O %A %B`])

    const fiber = Effect.runFork(sourceControl.publish(issue, prepared))
    await waitFor(async () => (await readdir(fixture.root)).includes('merge-started'))
    expect(await readdir(join(fixture.workspace, '.git'))).toContain('rebase-merge')

    await Effect.runPromise(Fiber.interrupt(fiber))

    // Without the abort, `.git/rebase-merge` survives and the next publication's rebase refuses to
    // start on it, wedging a workspace that is meant to be retried.
    expect(await readdir(join(fixture.workspace, '.git'))).not.toContain('rebase-merge')
    expect(await git(fixture.workspace, ['symbolic-ref', '--short', 'HEAD'])).toBe(
      'symphony/issue-185',
    )
    expect(await git(fixture.workspace, ['log', '-1', '--pretty=%s'])).toBe(
      'symphony: example/symphony#185 Interruptible publication',
    )
  }, 30_000)

  it('reports an invalid spawn argument in the error channel rather than as a defect', async (): Promise<void> => {
    const fixture = await makeGitRepository()
    roots.push(fixture.root)
    // `spawn` rejects a NUL byte by throwing synchronously instead of emitting `error`, which is
    // the one way of failing to start git that never reaches a listener.
    const sourceControl = makeGitSourceControl({
      remoteUrl: `${fixture.remote}${NUL}`,
      baseBranch: 'main',
      credential: Option.none(),
    })

    const failure = await Effect.runPromise(
      Effect.flip(
        sourceControl.prepare(
          issue,
          { path: fixture.workspace, key: 'issue-185', createdNow: true },
          { _tag: 'Normal', branchName: 'symphony/issue-185' },
        ),
      ),
    )

    expect(failure).toBeInstanceOf(SourceControlError)
    expect(failure).toMatchObject({ category: 'prepare_failed', retryable: true })
  })
})
