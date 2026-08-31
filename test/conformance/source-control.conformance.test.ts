import { createServer, type Server } from 'node:http'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect, Option, Redacted } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { makeGitSourceControl } from '../../src/adapters/node/source-control.js'
import { SourceControlError } from '../../src/errors.js'
import { issueId, issueIdentifier, type Issue } from '../../src/domain/domain.js'
import { commitFile, git, makeGitRepository } from '../harness/git-repository.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

const issue: Issue = {
  id: issueId('165'),
  nativeRef: null,
  identifier: issueIdentifier('example/symphony#165'),
  title: 'Host publication conformance',
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

// `live` throughout: every step here drives real git subprocesses and a real HTTP listener, so the
// suite needs the wall clock rather than the virtual one `it.effect` installs.
describe('SourceControlPort conformance', (): void => {
  it.live(
    'publishes a repair from the exact expected head after updating it onto protected main',
    () =>
      Effect.gen(function* () {
        const fixture = yield* host(makeGitRepository)
        roots.push(fixture.root)
        yield* host(() => git(fixture.seed, ['checkout', '-b', 'symphony/issue-165']))
        yield* host(() => commitFile(fixture.seed, 'feature.ts', 'initial\n', 'initial feature'))
        yield* host(() => git(fixture.seed, ['push', 'origin', 'symphony/issue-165']))
        const expectedHead = yield* host(() =>
          git(fixture.remote, ['rev-parse', 'refs/heads/symphony/issue-165']),
        )
        yield* host(() => git(fixture.seed, ['checkout', 'main']))
        const protectedHead = yield* host(() =>
          commitFile(fixture.seed, 'protected.ts', 'protected\n', 'advance main'),
        )
        yield* host(() => git(fixture.seed, ['push', 'origin', 'main']))
        const sourceControl = makeGitSourceControl({
          remoteUrl: fixture.remote,
          baseBranch: 'main',
          credential: Option.none(),
        })
        const prepared = yield* sourceControl.prepare(
          issue,
          { path: fixture.workspace, key: 'issue-165', createdNow: true },
          { _tag: 'Repair', branchName: 'symphony/issue-165', expectedHeadSha: expectedHead },
        )
        expect(yield* host(() => git(fixture.workspace, ['rev-parse', 'HEAD']))).toBe(expectedHead)
        yield* host(() => writeFile(join(fixture.workspace, 'feature.ts'), 'repaired\n'))

        const published = yield* sourceControl.publish(issue, prepared)

        expect(published._tag).toBe('Published')
        const remoteHead = yield* host(() =>
          git(fixture.remote, ['rev-parse', 'refs/heads/symphony/issue-165']),
        )
        expect(
          yield* host(() => git(fixture.workspace, ['merge-base', protectedHead, remoteHead])),
        ).toBe(protectedHead)
      }),
  )

  it.live('refuses a repair lease collision and preserves the local commit', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      yield* host(() => git(fixture.seed, ['checkout', '-b', 'symphony/issue-165']))
      yield* host(() => commitFile(fixture.seed, 'feature.ts', 'initial\n', 'initial feature'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'symphony/issue-165']))
      const expectedHead = yield* host(() =>
        git(fixture.remote, ['rev-parse', 'refs/heads/symphony/issue-165']),
      )
      const sourceControl = makeGitSourceControl({
        remoteUrl: fixture.remote,
        baseBranch: 'main',
        credential: Option.none(),
      })
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165', createdNow: true },
        { _tag: 'Repair', branchName: 'symphony/issue-165', expectedHeadSha: expectedHead },
      )
      yield* host(() => commitFile(fixture.seed, 'collision.ts', 'collision\n', 'colliding push'))
      yield* host(() => git(fixture.seed, ['push', 'origin', 'symphony/issue-165']))
      yield* host(() => writeFile(join(fixture.workspace, 'feature.ts'), 'local repair\n'))

      const failure = yield* Effect.flip(sourceControl.publish(issue, prepared))

      expect(failure).toMatchObject({
        _tag: 'SourceControlError',
        category: 'lease_conflict',
        retryable: true,
        worktreePreserved: true,
      })
      expect(yield* host(() => git(fixture.workspace, ['log', '-1', '--pretty=%s']))).toBe(
        'symphony: example/symphony#165 Host publication conformance',
      )
    }),
  )

  it.live('returns a retryable authentication publication failure and preserves the commit', () =>
    Effect.gen(function* () {
      const fixture = yield* host(makeGitRepository)
      roots.push(fixture.root)
      const sourceControl = makeGitSourceControl({
        remoteUrl: fixture.remote,
        baseBranch: 'main',
        credential: Option.some({ username: 'x-access-token', password: Redacted.make('secret') }),
      })
      const prepared = yield* sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165', createdNow: true },
        { _tag: 'Normal', branchName: 'symphony/issue-165' },
      )
      const server = createServer((_request, response) => {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
        response.end('unauthorized')
      })
      servers.push(server)
      yield* host(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)))
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('authentication test server did not bind')
      }
      yield* host(() =>
        git(fixture.workspace, [
          'remote',
          'set-url',
          'origin',
          `http://127.0.0.1:${String(address.port)}/repository.git`,
        ]),
      )
      yield* host(() => writeFile(join(fixture.workspace, 'implementation.ts'), 'local work\n'))

      const failure = yield* Effect.flip(sourceControl.publish(issue, prepared))

      expect(failure).toBeInstanceOf(SourceControlError)
      expect(failure).toMatchObject({
        category: 'authentication_failed',
        retryable: true,
        worktreePreserved: true,
      })
      expect(yield* host(() => git(fixture.workspace, ['log', '-1', '--pretty=%s']))).toBe(
        'symphony: example/symphony#165 Host publication conformance',
      )
    }),
  )
})
