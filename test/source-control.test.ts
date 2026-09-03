import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
      const workspace = { path: fixture.workspace, key: 'issue-165' }
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
        { path: fixture.workspace, key: 'issue-165' },
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
        { path: fixture.workspace, key: 'issue-165' },
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

  it.live('settles a retry whose push the remote already accepted', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = sourceControlFor(fixture)
      const workspace = { path: fixture.workspace, key: 'issue-165' }
      const target = { _tag: 'Normal' as const, branchName: 'sloppenheimer/issue-165' }
      const prepared = yield* sourceControl.prepare(issue, workspace, target)
      yield* host(() =>
        writeFile(join(fixture.workspace, 'implementation.ts'), 'export const done = true\n'),
      )
      const published = yield* sourceControl.publish(issue, prepared)

      // The same preparation published again, which is what a delivery retry does after a push the
      // remote accepted and the client did not see succeed: the lease still names the tip from
      // before, and the branch now carries this very commit.
      const retried = yield* sourceControl.publish(issue, prepared)

      expect(retried).toMatchObject({
        _tag: 'Published',
        branchName: 'sloppenheimer/issue-165',
        headSha: published._tag === 'Published' ? published.headSha : '',
      })
      expect(
        yield* host(() => git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165'])),
      ).toBe(published._tag === 'Published' ? published.headSha : '')
    }),
  )

  it.live('settles an accepted push whose base has moved under the retry', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = sourceControlFor(fixture)
      const workspace = { path: fixture.workspace, key: 'issue-165' }
      const target = { _tag: 'Normal' as const, branchName: 'sloppenheimer/issue-165' }
      const prepared = yield* sourceControl.prepare(issue, workspace, target)
      yield* host(() =>
        writeFile(join(fixture.workspace, 'implementation.ts'), 'export const done = true\n'),
      )
      const published = yield* sourceControl.publish(issue, prepared)

      // The protected base advances between the push the client did not see succeed and the
      // delivery's retry. Rebasing onto it rewrites the very commit the branch is carrying, so a
      // question asked afterwards can only answer that the work is undelivered — and then every
      // attempt fails the stale lease, spends the budget, and hands the agent back what is on the
      // remote.
      yield* host(() => git(fixture.seed, ['checkout', 'main']))
      yield* host(() => commitFile(fixture.seed, 'unrelated.ts', 'later\n', 'somebody else'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'main']))

      const retried = yield* sourceControl.publish(issue, prepared)

      expect(retried).toMatchObject({
        _tag: 'Published',
        branchName: 'sloppenheimer/issue-165',
        headSha: published._tag === 'Published' ? published.headSha : '',
      })
      // Untouched: the work was already there, so nothing was force-pushed over it.
      expect(
        yield* host(() => git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165'])),
      ).toBe(published._tag === 'Published' ? published.headSha : '')
    }),
  )

  it.live("continues a fresh workspace from the branch's published head", () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      yield* host(() => git(fixture.seed, ['checkout', '-b', 'sloppenheimer/issue-165']))
      yield* host(() =>
        commitFile(fixture.seed, 'attempt-one.ts', 'first attempt\n', 'first attempt'),
      )
      yield* host(() => git(fixture.seed, ['push', 'origin', 'sloppenheimer/issue-165']))
      const publishedHead = yield* host(() =>
        git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165']),
      )
      const sourceControl = sourceControlFor(fixture)

      // The workspace is empty, as every run's own workspace is. What carries the issue forward is
      // therefore the published branch, not what a previous attempt left in a shared worktree.
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165' },
        { _tag: 'Normal', branchName: 'sloppenheimer/issue-165' },
      )
      expect(yield* host(() => git(fixture.workspace, ['rev-parse', 'HEAD']))).toBe(publishedHead)
      expect(prepared.baselineSha).toBe(publishedHead)
      expect(yield* host(() => readFile(join(fixture.workspace, 'attempt-one.ts'), 'utf8'))).toBe(
        'first attempt\n',
      )

      yield* host(() => writeFile(join(fixture.workspace, 'attempt-two.ts'), 'second attempt\n'))
      const published = yield* sourceControl.publish(issue, prepared)

      // The second attempt builds on the first rather than resetting the branch over it. The
      // published head is a rebase of both commits onto the protected base, so what is asserted is
      // the work the branch carries, not the identity of a commit rebasing rewrites.
      expect(published._tag).toBe('Published')
      const remoteHead = yield* host(() =>
        git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165']),
      )
      expect(yield* host(() => git(fixture.workspace, ['rev-parse', 'HEAD']))).toBe(remoteHead)
      expect(
        yield* host(() => git(fixture.workspace, ['show', `${remoteHead}:attempt-one.ts`])),
      ).toBe('first attempt')
      expect(
        yield* host(() => git(fixture.workspace, ['show', `${remoteHead}:attempt-two.ts`])),
      ).toBe('second attempt')
    }),
  )

  it.live('puts a branch that fell behind back on top of protected main under its lease', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      yield* host(() => git(fixture.seed, ['checkout', '-b', 'sloppenheimer/issue-165']))
      yield* host(() => commitFile(fixture.seed, 'feature.ts', 'feature\n', 'the feature'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'sloppenheimer/issue-165']))
      const behindHead = yield* host(() =>
        git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165']),
      )
      yield* host(() => git(fixture.seed, ['checkout', 'main']))
      const protectedHead = yield* host(() =>
        commitFile(fixture.seed, 'protected.ts', 'protected\n', 'advance main'),
      )
      yield* host(() => git(fixture.seed, ['push', 'origin', 'main']))
      const sourceControl = sourceControlFor(fixture)
      // The preparation a repair gets: the exact pull-request head, under its lease. No agent
      // edits anything in between.
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165' },
        { _tag: 'Repair', branchName: 'sloppenheimer/issue-165', expectedHeadSha: behindHead },
      )

      const rebased = yield* sourceControl.rebase(issue, prepared)

      expect(rebased).toMatchObject({
        _tag: 'Published',
        branchName: 'sloppenheimer/issue-165',
        commitCreated: false,
      })
      const remoteHead = yield* host(() =>
        git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165']),
      )
      expect(remoteHead).toBe(rebased._tag === 'Published' ? rebased.headSha : '')
      expect(remoteHead).not.toBe(behindHead)
      // On top of the base now, carrying the same change and no commit of the host's own.
      expect(
        yield* host(() => git(fixture.workspace, ['merge-base', protectedHead, remoteHead])),
      ).toBe(protectedHead)
      expect(yield* host(() => git(fixture.workspace, ['show', `${remoteHead}:feature.ts`]))).toBe(
        'feature',
      )
      expect(yield* host(() => git(fixture.workspace, ['log', '-1', '--pretty=%s']))).toBe(
        'the feature',
      )
    }),
  )

  it.live('reports a branch already on top of protected main as unchanged', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      yield* host(() => git(fixture.seed, ['checkout', '-b', 'sloppenheimer/issue-165']))
      yield* host(() => commitFile(fixture.seed, 'feature.ts', 'feature\n', 'the feature'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'sloppenheimer/issue-165']))
      const currentHead = yield* host(() =>
        git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165']),
      )
      const sourceControl = sourceControlFor(fixture)
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165' },
        { _tag: 'Repair', branchName: 'sloppenheimer/issue-165', expectedHeadSha: currentHead },
      )

      // The observation that asked for this was stale: nothing is pushed, and the branch is where
      // it was.
      expect(yield* sourceControl.rebase(issue, prepared)).toEqual({
        _tag: 'NoChanges',
        branchName: 'sloppenheimer/issue-165',
        baselineSha: currentHead,
      })
      expect(
        yield* host(() => git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165'])),
      ).toBe(currentHead)
    }),
  )

  it.live('refuses to rebase over a branch that moved after it was prepared', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      yield* host(() => git(fixture.seed, ['checkout', '-b', 'sloppenheimer/issue-165']))
      yield* host(() => commitFile(fixture.seed, 'feature.ts', 'feature\n', 'the feature'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'sloppenheimer/issue-165']))
      const behindHead = yield* host(() =>
        git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165']),
      )
      yield* host(() => git(fixture.seed, ['checkout', 'main']))
      yield* host(() => commitFile(fixture.seed, 'protected.ts', 'protected\n', 'advance main'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'main']))
      const sourceControl = sourceControlFor(fixture)
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165' },
        { _tag: 'Repair', branchName: 'sloppenheimer/issue-165', expectedHeadSha: behindHead },
      )
      // Somebody pushes to the branch between the observation and the rebase.
      yield* host(() => git(fixture.seed, ['checkout', 'sloppenheimer/issue-165']))
      const collidingHead = yield* host(() =>
        commitFile(fixture.seed, 'collision.ts', 'collision\n', 'colliding push'),
      )
      yield* host(() => git(fixture.seed, ['push', 'origin', 'sloppenheimer/issue-165']))

      const failure = yield* Effect.flip(sourceControl.rebase(issue, prepared))

      expect(failure).toMatchObject({ _tag: 'SourceControlError', category: 'lease_conflict' })
      expect(
        yield* host(() => git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165'])),
      ).toBe(collidingHead)
    }),
  )

  it.live('reports a content conflict as a conflict, and leaves no rebase state behind', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      yield* host(() =>
        commitFile(fixture.seed, 'contested.ts', 'base\n', 'add the contested file'),
      )
      yield* host(() => git(fixture.seed, ['push', 'origin', 'main']))
      yield* host(() => git(fixture.seed, ['checkout', '-b', 'sloppenheimer/issue-165']))
      yield* host(() => commitFile(fixture.seed, 'contested.ts', 'ours\n', 'change the file'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'sloppenheimer/issue-165']))
      const behindHead = yield* host(() =>
        git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165']),
      )
      yield* host(() => git(fixture.seed, ['checkout', 'main']))
      yield* host(() => commitFile(fixture.seed, 'contested.ts', 'theirs\n', 'advance the file'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'main']))
      const sourceControl = sourceControlFor(fixture)
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165' },
        { _tag: 'Repair', branchName: 'sloppenheimer/issue-165', expectedHeadSha: behindHead },
      )

      const failure = yield* Effect.flip(sourceControl.rebase(issue, prepared))

      expect(failure).toMatchObject({ _tag: 'SourceControlError', category: 'rebase_conflict' })
      expect(failure.message).toContain('could not rebase onto the protected base')
      expect(yield* host(() => readdir(join(fixture.workspace, '.git')))).not.toContain(
        'rebase-merge',
      )
      expect(
        yield* host(() => git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165'])),
      ).toBe(behindHead)
    }),
  )

  it.live('keeps a rebase git refused to start apart from a conflict', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      yield* host(() => git(fixture.seed, ['checkout', '-b', 'sloppenheimer/issue-165']))
      yield* host(() => commitFile(fixture.seed, 'feature.ts', 'feature\n', 'the feature'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'sloppenheimer/issue-165']))
      const behindHead = yield* host(() =>
        git(fixture.remote, ['rev-parse', 'refs/heads/sloppenheimer/issue-165']),
      )
      yield* host(() => git(fixture.seed, ['checkout', 'main']))
      yield* host(() => commitFile(fixture.seed, 'protected.ts', 'protected\n', 'advance main'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'main']))
      const sourceControl = sourceControlFor(fixture)
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165' },
        { _tag: 'Repair', branchName: 'sloppenheimer/issue-165', expectedHeadSha: behindHead },
      )
      // A rebase git will not begin: the state of one it believes is still in progress. Nothing
      // about the content conflicts, and a caller that read this as a conflict would give up on a
      // pull request a later attempt could still bring up to date.
      yield* host(() => mkdir(join(fixture.workspace, '.git', 'rebase-merge')))

      const failure = yield* Effect.flip(sourceControl.rebase(issue, prepared))

      expect(failure).toMatchObject({
        _tag: 'SourceControlError',
        category: 'publication_failed',
        retryable: true,
      })
      expect(failure.message).toContain('git rebase failed')
    }),
  )

  it.live('reports an empty diff without creating a remote branch', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = sourceControlFor(fixture)
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165' },
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
