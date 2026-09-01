import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { issueId, issueIdentifier, type Issue } from '@sloppenheimer/core/domain/domain.js'
import { commitFile, makeGitRepository, git } from './harness/git-repository.js'
import { anIssue, sourceControlFor } from './harness/fixtures.js'

const roots: string[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

const issue: Issue = anIssue({
  id: issueId('165'),
  identifier: issueIdentifier('example/sloppenheimer#165'),
  title: 'Host-owned publication',
  priority: 1,
})

/** The git fixture is promise-shaped; this lifts one of its calls into the effect under test. */
const host = <Value>(work: () => Promise<Value>): Effect.Effect<Value> => Effect.promise(work)

// `live` throughout: every step drives real git subprocesses, so the suite needs the wall clock.
describe('host Git source control', (): void => {
  it.live('prepares protected main and publishes a deterministic agent diff', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = sourceControlFor(fixture)
      const workspace = { path: fixture.workspace, key: 'issue-165', createdNow: true }
      const prepared = yield* sourceControl.prepare(issue, workspace, {
        _tag: 'Normal',
        branchName: 'sloppenheimer/issue-165',
      })

      expect(yield* host(() => readFile(join(fixture.workspace, 'README.md'), 'utf8'))).toBe(
        'base\n',
      )
      yield* host(() =>
        writeFile(join(fixture.workspace, 'implementation.ts'), 'export const done = true\n'),
      )
      const published = yield* sourceControl.publish(issue, prepared)

      expect(published).toMatchObject({
        _tag: 'Published',
        branchName: 'sloppenheimer/issue-165',
        commitCreated: true,
      })
      expect(
        yield* host(() => git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165'])),
      ).toBe(published._tag === 'Published' ? published.headSha : '')
      expect(yield* host(() => git(fixture.workspace, ['log', '-1', '--pretty=%s']))).toBe(
        'sloppenheimer: example/sloppenheimer#165 Host-owned publication',
      )
    }),
  )

  it.live('reads a prepared worktree as clean, and an agent edit as work to deliver', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = sourceControlFor(fixture)
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165', createdNow: true },
        { _tag: 'Normal', branchName: 'sloppenheimer/issue-165' },
      )

      expect(yield* sourceControl.inspect(prepared)).toEqual({
        _tag: 'Clean',
        headSha: prepared.baselineSha,
      })

      yield* host(() =>
        writeFile(join(fixture.workspace, 'implementation.ts'), 'export const done = true\n'),
      )

      expect(yield* sourceControl.inspect(prepared)).toMatchObject({
        _tag: 'Changed',
        dirtyFileCount: 1,
        committedAhead: false,
      })
    }),
  )

  it.live('reads a commit the last publication could not push as work to deliver', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = sourceControlFor(fixture)
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165', createdNow: true },
        { _tag: 'Normal', branchName: 'sloppenheimer/issue-165' },
      )
      // The shape a publication that committed and then failed to push leaves behind: nothing is
      // dirty any more, and reading that as an empty worktree would discard the work.
      yield* host(() =>
        commitFile(fixture.workspace, 'implementation.ts', 'export const done = true\n', 'work'),
      )

      const inspected = yield* sourceControl.inspect(prepared)

      expect(inspected).toMatchObject({
        _tag: 'Changed',
        dirtyFileCount: 0,
        committedAhead: true,
      })
    }),
  )

  it.live('reads an already-published workspace as clean on a later preparation', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = sourceControlFor(fixture)
      const workspace = { path: fixture.workspace, key: 'issue-165', createdNow: true }
      const target = { _tag: 'Normal' as const, branchName: 'sloppenheimer/issue-165' }
      const first = yield* sourceControl.prepare(issue, workspace, target)
      yield* host(() =>
        writeFile(join(fixture.workspace, 'implementation.ts'), 'export const done = true\n'),
      )
      yield* sourceControl.publish(issue, first)

      // What a restart does: a fresh preparation of the same workspace. The commit is on the
      // remote now, so there is nothing retained — reading it as retained work would have every
      // restart republishing what the last process already delivered.
      const second = yield* sourceControl.prepare(issue, workspace, target)

      expect(yield* sourceControl.inspect(second)).toMatchObject({ _tag: 'Clean' })
    }),
  )

  it.live('reads a workspace the branch has moved past as clean, not as work to deliver', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = sourceControlFor(fixture)
      const workspace = { path: fixture.workspace, key: 'issue-165', createdNow: true }
      const target = { _tag: 'Normal' as const, branchName: 'sloppenheimer/issue-165' }
      const first = yield* sourceControl.prepare(issue, workspace, target)
      yield* host(() =>
        writeFile(join(fixture.workspace, 'implementation.ts'), 'export const done = true\n'),
      )
      yield* sourceControl.publish(issue, first)

      // The host is down while the branch advances: somebody else pushes on top of what it
      // delivered, and its workspace is left holding the older commit.
      yield* host(() => git(fixture.seed, ['fetch', 'origin', 'sloppenheimer/issue-165']))
      yield* host(() =>
        git(fixture.seed, ['checkout', '-B', 'sloppenheimer/issue-165', 'FETCH_HEAD']),
      )
      yield* host(() => commitFile(fixture.seed, 'later.ts', 'later\n', 'somebody else'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'sloppenheimer/issue-165']))

      // Reading that as unpublished work would republish it under a lease that matches the newer
      // remote head, and the intervening commit would be gone.
      const second = yield* sourceControl.prepare(issue, workspace, target)

      expect(yield* sourceControl.inspect(second)).toMatchObject({ _tag: 'Clean' })
      expect(
        yield* host(() =>
          git(fixture.remote, ['log', '-1', '--pretty=%s', 'sloppenheimer/issue-165']),
        ),
      ).toBe('somebody else')
    }),
  )

  it.live('resets a workspace the branch has moved past, rather than preserving a stale head', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = sourceControlFor(fixture)
      const workspace = { path: fixture.workspace, key: 'issue-165', createdNow: true }
      const target = { _tag: 'Normal' as const, branchName: 'sloppenheimer/issue-165' }
      const first = yield* sourceControl.prepare(issue, workspace, target)
      yield* host(() =>
        writeFile(join(fixture.workspace, 'implementation.ts'), 'export const done = true\n'),
      )
      yield* sourceControl.publish(issue, first)
      yield* host(() => git(fixture.seed, ['fetch', 'origin', 'sloppenheimer/issue-165']))
      yield* host(() =>
        git(fixture.seed, ['checkout', '-B', 'sloppenheimer/issue-165', 'FETCH_HEAD']),
      )
      yield* host(() => commitFile(fixture.seed, 'later.ts', 'later\n', 'somebody else'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'sloppenheimer/issue-165']))

      // What the next agent receives. Preserving the stale head would start it from a commit the
      // branch has moved past — and republish that commit as though it were new work.
      const second = yield* sourceControl.prepare(issue, workspace, target)

      expect(yield* host(() => git(fixture.workspace, ['rev-parse', 'HEAD']))).toBe(
        second.baselineSha,
      )
      yield* Effect.promise(() =>
        expect(readFile(join(fixture.workspace, 'implementation.ts'), 'utf8')).rejects.toThrow(),
      )
      expect(yield* sourceControl.inspect(second)).toMatchObject({ _tag: 'Clean' })
    }),
  )

  it.live('reports an empty diff without creating a remote branch', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = sourceControlFor(fixture)
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165', createdNow: true },
        { _tag: 'Normal', branchName: 'sloppenheimer/issue-165' },
      )

      expect(yield* sourceControl.publish(issue, prepared)).toEqual({
        _tag: 'NoChanges',
        branchName: 'sloppenheimer/issue-165',
        baselineSha: prepared.baseSha,
      })
      yield* Effect.promise(() =>
        expect(
          git(fixture.remote, ['rev-parse', '--verify', 'refs/heads/sloppenheimer/issue-165']),
        ).rejects.toThrow(),
      )
    }),
  )
})
