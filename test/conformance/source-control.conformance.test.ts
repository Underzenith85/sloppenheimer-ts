import { createServer, type Server } from 'node:http'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Option, Redacted } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

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

describe('SourceControlPort conformance', (): void => {
  it('publishes a repair from the exact expected head after updating it onto protected main', async (): Promise<void> => {
    const fixture = await makeGitRepository()
    roots.push(fixture.root)
    await git(fixture.seed, ['checkout', '-b', 'symphony/issue-165'])
    await commitFile(fixture.seed, 'feature.ts', 'initial\n', 'initial feature')
    await git(fixture.seed, ['push', 'origin', 'symphony/issue-165'])
    const expectedHead = await git(fixture.remote, ['rev-parse', 'refs/heads/symphony/issue-165'])
    await git(fixture.seed, ['checkout', 'main'])
    const protectedHead = await commitFile(
      fixture.seed,
      'protected.ts',
      'protected\n',
      'advance main',
    )
    await git(fixture.seed, ['push', 'origin', 'main'])
    const sourceControl = makeGitSourceControl({
      remoteUrl: fixture.remote,
      baseBranch: 'main',
      credential: Option.none(),
    })
    const prepared = await Effect.runPromise(
      sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165', createdNow: true },
        { _tag: 'Repair', branchName: 'symphony/issue-165', expectedHeadSha: expectedHead },
      ),
    )
    expect(await git(fixture.workspace, ['rev-parse', 'HEAD'])).toBe(expectedHead)
    await writeFile(join(fixture.workspace, 'feature.ts'), 'repaired\n')

    const published = await Effect.runPromise(sourceControl.publish(issue, prepared))

    expect(published._tag).toBe('Published')
    const remoteHead = await git(fixture.remote, ['rev-parse', 'refs/heads/symphony/issue-165'])
    expect(await git(fixture.workspace, ['merge-base', protectedHead, remoteHead])).toBe(
      protectedHead,
    )
  })

  it('refuses a repair lease collision and preserves the local commit', async (): Promise<void> => {
    const fixture = await makeGitRepository()
    roots.push(fixture.root)
    await git(fixture.seed, ['checkout', '-b', 'symphony/issue-165'])
    await commitFile(fixture.seed, 'feature.ts', 'initial\n', 'initial feature')
    await git(fixture.seed, ['push', 'origin', 'symphony/issue-165'])
    const expectedHead = await git(fixture.remote, ['rev-parse', 'refs/heads/symphony/issue-165'])
    const sourceControl = makeGitSourceControl({
      remoteUrl: fixture.remote,
      baseBranch: 'main',
      credential: Option.none(),
    })
    const prepared = await Effect.runPromise(
      sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165', createdNow: true },
        { _tag: 'Repair', branchName: 'symphony/issue-165', expectedHeadSha: expectedHead },
      ),
    )
    await commitFile(fixture.seed, 'collision.ts', 'collision\n', 'colliding push')
    await git(fixture.seed, ['push', 'origin', 'symphony/issue-165'])
    await writeFile(join(fixture.workspace, 'feature.ts'), 'local repair\n')

    const failure = await Effect.runPromise(Effect.flip(sourceControl.publish(issue, prepared)))

    expect(failure).toMatchObject({
      _tag: 'SourceControlError',
      category: 'lease_conflict',
      retryable: true,
      worktreePreserved: true,
    })
    expect(await git(fixture.workspace, ['log', '-1', '--pretty=%s'])).toBe(
      'symphony: example/symphony#165 Host publication conformance',
    )
  })

  it('returns a retryable authentication publication failure and preserves the commit', async (): Promise<void> => {
    const fixture = await makeGitRepository()
    roots.push(fixture.root)
    const sourceControl = makeGitSourceControl({
      remoteUrl: fixture.remote,
      baseBranch: 'main',
      credential: Option.some({ username: 'x-access-token', password: Redacted.make('secret') }),
    })
    const prepared = await Effect.runPromise(
      sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-165', createdNow: true },
        { _tag: 'Normal', branchName: 'symphony/issue-165' },
      ),
    )
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
      response.end('unauthorized')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('authentication test server did not bind')
    }
    await git(fixture.workspace, [
      'remote',
      'set-url',
      'origin',
      `http://127.0.0.1:${String(address.port)}/repository.git`,
    ])
    await writeFile(join(fixture.workspace, 'implementation.ts'), 'local work\n')

    const failure = await Effect.runPromise(Effect.flip(sourceControl.publish(issue, prepared)))

    expect(failure).toBeInstanceOf(SourceControlError)
    expect(failure).toMatchObject({
      category: 'authentication_failed',
      retryable: true,
      worktreePreserved: true,
    })
    expect(await git(fixture.workspace, ['log', '-1', '--pretty=%s'])).toBe(
      'symphony: example/symphony#165 Host publication conformance',
    )
  })
})
