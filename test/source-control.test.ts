import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { makeGitSourceControl } from '../src/adapters/node/source-control.js'
import { issueId, issueIdentifier, type Issue } from '../src/domain/domain.js'
import { makeGitRepository, git } from './harness/git-repository.js'

const roots: string[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

const issue: Issue = {
  id: issueId('165'),
  nativeRef: null,
  identifier: issueIdentifier('example/symphony#165'),
  title: 'Host-owned publication',
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

/** The git fixture is promise-shaped; this lifts one of its calls into the effect under test. */
const host = <Value>(work: () => Promise<Value>): Effect.Effect<Value> => Effect.promise(work)

// `live` throughout: every step drives real git subprocesses, so the suite needs the wall clock.
describe('host Git source control', (): void => {
  it.live('prepares protected main and publishes a deterministic agent diff', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = makeGitSourceControl({
        remoteUrl: fixture.remote,
        baseBranch: 'main',
        credential: Option.none(),
      })
      const workspace = { path: fixture.workspace, key: 'issue-165', createdNow: true }
      const prepared = yield* sourceControl.prepare(issue, workspace, {
        _tag: 'Normal',
        branchName: 'symphony/issue-165',
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
        branchName: 'symphony/issue-165',
        commitCreated: true,
      })
      expect(
        yield* host(() => git(fixture.remote, ['rev-parse', 'refs/heads/symphony/issue-165'])),
      ).toBe(published._tag === 'Published' ? published.headSha : '')
      expect(yield* host(() => git(fixture.workspace, ['log', '-1', '--pretty=%s']))).toBe(
        'symphony: example/symphony#165 Host-owned publication',
      )
    }),
  )

  it.live('reports an empty diff without creating a remote branch', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = makeGitSourceControl({
        remoteUrl: fixture.remote,
        baseBranch: 'main',
        credential: Option.none(),
      })
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165', createdNow: true },
        { _tag: 'Normal', branchName: 'symphony/issue-165' },
      )

      expect(yield* sourceControl.publish(issue, prepared)).toEqual({
        _tag: 'NoChanges',
        branchName: 'symphony/issue-165',
        baselineSha: prepared.baseSha,
      })
      yield* Effect.promise(() =>
        expect(
          git(fixture.remote, ['rev-parse', '--verify', 'refs/heads/symphony/issue-165']),
        ).rejects.toThrow(),
      )
    }),
  )
})
