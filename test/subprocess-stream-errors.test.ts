import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { rm, writeFile } from 'node:fs/promises'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HooksConfig } from '@sloppenheimer/core/config/workflow.js'
import { makeWorkspaceManager } from '@sloppenheimer/adapter-node/workspace-manager.js'
import { issueId, issueIdentifier, type Issue } from '@sloppenheimer/core/domain/domain.js'
import { hostFileSystem } from './harness/filesystem.js'
import { makeGitRepository } from './harness/git-repository.js'
import { anIssue, sourceControlFor } from './harness/fixtures.js'

/**
 * Which spawned child to fail an output pipe on, and which pipe.
 *
 * A pipe belongs to the adapter that spawned the child and never leaves it, so no fixture can fail
 * one from outside. Wrapping `spawn` is what puts the `ChildProcess` within a test's reach; the
 * child itself is the real one, and so is everything the failing pipe goes on to affect.
 *
 * The error is raised on the stream rather than by destroying it, which is what isolates the pipe
 * failure from the process outcome. Destroying the pipe breaks the child's stdio too — git and bash
 * both take `SIGPIPE` and die — so the operation would fail for that reason whether or not the
 * listener exists, and the assertions would hold against the unfixed code. Raised on its own, the
 * pipe fails while the child runs to its normal exit, which is the case that separates a lost
 * output from a lost process.
 *
 * It is raised asynchronously because the adapter attaches its listeners after `spawn` returns.
 */
type PipeFailure = Readonly<{
  matches: (command: string, args: readonly string[]) => boolean
  pipe: 'stdout' | 'stderr'
}>

let pendingFailure: PipeFailure | null = null

const failPipeOnce = (failure: PipeFailure): void => {
  pendingFailure = failure
}

vi.mock(
  'node:child_process',
  async (importOriginal): Promise<typeof import('node:child_process')> => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
      ...actual,
      spawn: ((...parameters: Parameters<typeof actual.spawn>): ChildProcess => {
        const child = actual.spawn(...parameters)
        const failure = pendingFailure
        if (failure === null) {
          return child
        }
        const argument = parameters[1]
        const args = Array.isArray(argument) ? argument.map((value) => String(value)) : []
        if (!failure.matches(String(parameters[0]), args)) {
          return child
        }
        pendingFailure = null
        const pipe = child[failure.pipe]
        if (pipe !== null) {
          setImmediate(() => {
            pipe.emit('error', new Error('output pipe failed'))
          })
        }
        return child
      }) as typeof actual.spawn,
    }
  },
)

const roots: string[] = []

afterEach(async (): Promise<void> => {
  pendingFailure = null
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

const issue: Issue = anIssue({
  id: issueId('200'),
  identifier: issueIdentifier('example/sloppenheimer#200'),
  title: 'Survive a failing output pipe',
  priority: 1,
})

const hooks = (overrides: Partial<HooksConfig>): HooksConfig => ({
  afterCreate: null,
  beforeRun: null,
  afterRun: null,
  beforeRemove: null,
  timeoutMs: 5_000,
  ...overrides,
})

/*
 * Both assertions below would have taken the whole worker down before the listeners existed: Node
 * rethrows an `error` event with no listener as an uncaught exception, so the failure mode was a
 * dead host rather than a failed operation. That each test now reaches an assertion at all is half
 * of what it is checking; what it asserts is the other half — that the failure is reported as the
 * operation's own, and never as a success carrying a truncated answer.
 */
describe('a child output pipe that fails', (): void => {
  it('fails the git invocation rather than returning the output it managed to read', async (): Promise<void> => {
    const fixture = await makeGitRepository()
    roots.push(fixture.root)
    const sourceControl = sourceControlFor(fixture)

    // The revision of the protected base, read from this invocation's stdout. `initialize` runs
    // first and recovers from any failure of its own, so a pipe failed there would be swallowed;
    // this one's output is data the preparation goes on to use, which is what must not be truncated.
    // git exits 0 here — only the pipe failed — so nothing but the recorded failure stands between
    // a half-read revision and a preparation that proceeds on it.
    failPipeOnce({
      matches: (command, args) =>
        command === 'git' &&
        args[0] === 'rev-parse' &&
        args[1]?.startsWith('refs/remotes/') === true,
      pipe: 'stdout',
    })

    const error = await Effect.runPromise(
      Effect.flip(
        sourceControl.prepare(
          issue,
          { path: fixture.workspace, key: 'issue-200' },
          { _tag: 'Normal', branchName: 'sloppenheimer/issue-200' },
        ),
      ),
    )

    expect(error.category).toBe('prepare_failed')
    expect(error.worktreePreserved).toBe(false)
  }, 30_000)

  /*
   * The classification reads git's diagnostics, not its data. `status --porcelain` writes the
   * workspace's own file names to stdout, and a failure carries whatever of that had been read; a
   * path — or, in the case above, a commit SHA — that happens to contain `403` is not an HTTP
   * status, and must not turn a publication failure into an authentication failure and a
   * credential problem the operator does not have.
   */
  it('classifies a failure by git diagnostics rather than by output that looks like a status', async (): Promise<void> => {
    const fixture = await makeGitRepository()
    roots.push(fixture.root)
    const sourceControl = sourceControlFor(fixture)
    const prepared = await Effect.runPromise(
      sourceControl.prepare(
        issue,
        { path: fixture.workspace, key: 'issue-403' },
        { _tag: 'Normal', branchName: 'sloppenheimer/issue-403' },
      ),
    )
    await writeFile(join(fixture.workspace, 'issue-403.ts'), 'untracked\n')

    failPipeOnce({
      matches: (command, args) => command === 'git' && args[0] === 'status',
      pipe: 'stdout',
    })

    const error = await Effect.runPromise(Effect.flip(sourceControl.publish(issue, prepared)))

    expect(error.category).toBe('publication_failed')
  }, 30_000)

  it('reports a hook diagnostic as truncated rather than failing the hook on it', async (): Promise<void> => {
    const fixture = await makeGitRepository()
    roots.push(fixture.root)
    const manager = await Effect.runPromise(
      makeWorkspaceManager(fixture.root, hooks({ beforeRun: 'echo "boom" >&2; exit 7' })).pipe(
        Effect.provide(hostFileSystem),
      ),
    )
    const leased = await Effect.runPromise(
      manager.acquire({ identifier: issueIdentifier('GH-200'), runId: 1 }),
    )
    const workspace = leased.workspace

    failPipeOnce({ matches: (command) => command === 'bash', pipe: 'stderr' })

    const error = await Effect.runPromise(Effect.flip(manager.beforeRun(workspace)))

    // What a hook writes is diagnostic; its contract is the exit code. So the lost stderr does not
    // become the failure — the hook's own `exit 7` is still what is reported — but the diagnostic
    // that survived is marked rather than passed off as the whole of it.
    expect(error.category).toBe('hook_failed')
    expect(error.message).toContain('before_run hook exited with 7')
    expect(error.message).toContain('… (truncated)')
  }, 30_000)
})
