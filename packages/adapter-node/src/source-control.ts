import { Effect, Option } from 'effect'

import type { Issue, Workspace } from '@sloppenheimer/core/domain/domain.js'
import { SourceControlError } from '@sloppenheimer/core/domain/errors.js'
import type {
  PreparedRepository,
  PublicationOutcome,
  SourceControlPort,
  SourceControlTarget,
} from '@sloppenheimer/core/ports/source-control.js'
import {
  gitIdentity,
  runGit,
  type GitOperation,
  type GitSourceControlSettings,
} from './git-process.js'

export type { GitCredential, GitSourceControlSettings } from './git-process.js'

/**
 * Host Git source control: preparing a run's own workspace from the branch's published head, the
 * exact head of a repair, or the protected base, and publishing the agent's work back under an
 * expected-head lease.
 *
 * How a git invocation is run, authenticated, and read when it fails lives in `git-process.ts`;
 * this module decides only which invocations to make and what their output means.
 */

const remoteHead = (
  settings: GitSourceControlSettings,
  operation: GitOperation,
  workspace: Workspace,
  branchName: string,
): Effect.Effect<Option.Option<string>, SourceControlError> =>
  Effect.map(
    runGit(settings, operation, workspace.path, [
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${branchName}`,
    ]),
    (output) => {
      const sha = output.trim().split(/\s+/u)[0]
      return sha === undefined || sha.length === 0 ? Option.none() : Option.some(sha)
    },
  )

const revParse = (
  settings: GitSourceControlSettings,
  operation: GitOperation,
  workspace: Workspace,
  revision: string,
): Effect.Effect<string, SourceControlError> =>
  Effect.map(runGit(settings, operation, workspace.path, ['rev-parse', revision]), (value) =>
    value.trim(),
  )

const status = (
  settings: GitSourceControlSettings,
  operation: GitOperation,
  workspace: Workspace,
): Effect.Effect<string, SourceControlError> =>
  runGit(settings, operation, workspace.path, ['status', '--porcelain=v1', '--untracked-files=all'])

const initialize = (
  settings: GitSourceControlSettings,
  workspace: Workspace,
): Effect.Effect<void, SourceControlError> =>
  runGit(settings, 'prepare', workspace.path, ['rev-parse', '--git-dir']).pipe(
    Effect.zipRight(
      runGit(settings, 'prepare', workspace.path, [
        'remote',
        'set-url',
        'origin',
        settings.remoteUrl,
      ]),
    ),
    Effect.catchAll(() =>
      runGit(settings, 'prepare', workspace.path, ['init']).pipe(
        Effect.zipRight(
          runGit(settings, 'prepare', workspace.path, [
            'remote',
            'add',
            'origin',
            settings.remoteUrl,
          ]),
        ),
      ),
    ),
    Effect.asVoid,
  )

/**
 * The head a repair must start from, or `none` for normal work, which starts from the branch's own
 * published head instead, or from the protected base when it has none. Absence here chooses the
 * next branch rather than crossing a data boundary, so it is an `Option` and never leaves this
 * module.
 */
const expectedRepairHead = (
  target: SourceControlTarget,
  observed: Option.Option<string>,
): Effect.Effect<Option.Option<string>, SourceControlError> => {
  if (target._tag === 'Normal') {
    return Effect.succeed(Option.none())
  }
  if (Option.contains(observed, target.expectedHeadSha)) {
    return Effect.succeed(Option.some(target.expectedHeadSha))
  }
  return Effect.fail(
    new SourceControlError({
      category: 'lease_conflict',
      message: `remote branch ${target.branchName} no longer matches expected head ${target.expectedHeadSha}`,
      retryable: true,
      worktreePreserved: true,
    }),
  )
}

/**
 * Puts the target branch at the baseline with nothing carried over.
 *
 * Uninterruptible as a pair. `checkout -B` carries a tracked edit across when the file is identical
 * in both commits, so an interruption between the two would leave the target branch checked out and
 * still dirty, and the run that inherited it would publish an edit no agent made. The two commands
 * are local and bounded, so an interruption waits them out rather than settling halfway through.
 */
const resetToBaseline = (
  settings: GitSourceControlSettings,
  workspace: Workspace,
  branchName: string,
  baselineSha: string,
): Effect.Effect<void, SourceControlError> =>
  Effect.uninterruptible(
    runGit(settings, 'prepare', workspace.path, ['checkout', '-B', branchName, baselineSha]).pipe(
      Effect.zipRight(
        runGit(settings, 'prepare', workspace.path, ['reset', '--hard', baselineSha]),
      ),
      Effect.asVoid,
    ),
  )

/**
 * The baseline a run starts from, and the fetch that makes it available locally.
 *
 * A repair starts from the exact pull-request head it was dispatched against. Normal work starts
 * from the branch's own published head when the branch exists, and from the protected base when it
 * does not: since [#166](https://github.com/Underzenith85/sloppenheimer-ts/issues/166) every run is
 * given a workspace of its own, so what a previous attempt left in a shared worktree is no longer
 * what carries an issue forward — the published branch is. Work that was never published survives
 * only in that attempt's retained workspace, and is never silently adopted here.
 */
const fetchBaseline = (
  settings: GitSourceControlSettings,
  workspace: Workspace,
  target: SourceControlTarget,
  observedRemoteHead: Option.Option<string>,
  baseSha: string,
): Effect.Effect<string, SourceControlError> =>
  Effect.gen(function* () {
    const repairHead = yield* expectedRepairHead(target, observedRemoteHead)
    const publishedHead = Option.orElse(repairHead, () => observedRemoteHead)
    if (Option.isNone(publishedHead)) {
      return baseSha
    }
    yield* runGit(settings, 'prepare', workspace.path, [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${target.branchName}:refs/remotes/origin/${target.branchName}`,
    ])
    return publishedHead.value
  })

const prepareRepository = (
  settings: GitSourceControlSettings,
  issue: Issue,
  workspace: Workspace,
  target: SourceControlTarget,
): Effect.Effect<PreparedRepository, SourceControlError> =>
  Effect.gen(function* () {
    void issue
    yield* initialize(settings, workspace)
    yield* runGit(settings, 'prepare', workspace.path, [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${settings.baseBranch}:refs/remotes/origin/${settings.baseBranch}`,
    ])
    const baseSha = yield* revParse(
      settings,
      'prepare',
      workspace,
      `refs/remotes/origin/${settings.baseBranch}`,
    )
    const observedRemoteHead = yield* remoteHead(settings, 'prepare', workspace, target.branchName)
    const baselineSha = yield* fetchBaseline(
      settings,
      workspace,
      target,
      observedRemoteHead,
      baseSha,
    )
    // The workspace belongs to this run alone, so there is never anything in it to keep: the branch
    // is put at the baseline unconditionally rather than after asking what the directory holds.
    yield* resetToBaseline(settings, workspace, target.branchName, baselineSha)
    const prepared: PreparedRepository = {
      workspace,
      target,
      baseBranch: settings.baseBranch,
      baseSha,
      baselineSha,
      expectedRemoteHead: observedRemoteHead,
    }
    return prepared
  })

const sameHead = (left: Option.Option<string>, right: Option.Option<string>): boolean =>
  Option.match(left, {
    onNone: () => Option.isNone(right),
    onSome: (sha) => Option.contains(right, sha),
  })

const leaseFailure = (
  prepared: PreparedRepository,
  actual: Option.Option<string>,
): SourceControlError =>
  new SourceControlError({
    category: 'lease_conflict',
    message: `remote branch ${prepared.target.branchName} changed after preparation (expected ${Option.getOrElse(prepared.expectedRemoteHead, () => 'absent')}, found ${Option.getOrElse(actual, () => 'absent')})`,
    retryable: true,
    worktreePreserved: true,
  })

/**
 * Returns the worktree to the head the rebase started from.
 *
 * Uninterruptible, so the guarantee belongs to the cleanup itself rather than to the path that
 * reaches it: an abort that were cancelled halfway would leave exactly the half-written rebase
 * state it exists to clear, and the failure path runs it as an ordinary effect rather than as a
 * finalizer. An interruption therefore waits out one bounded local git invocation.
 *
 * The abort's own outcome is discarded: after a failure the original one is the useful diagnostic,
 * and a rebase that left no state behind needs no cleanup and says so by exiting non-zero.
 */
const abortRebase = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.ignore(runGit(settings, 'publish', prepared.workspace.path, ['rebase', '--abort'])),
  )

const rebaseOntoBase = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
): Effect.Effect<void, SourceControlError> =>
  Effect.catchAll(
    // An interruption terminates the git process group mid-rebase, which leaves `.git/rebase-merge`
    // and a detached head behind. `Effect.catchAll` does not see an interruption, and the next
    // publication's rebase refuses to start on the state this one left, so the abort is also
    // attached as a finalizer.
    Effect.onInterrupt(
      Effect.asVoid(
        runGit(
          settings,
          'publish',
          prepared.workspace.path,
          [
            'rebase',
            '--committer-date-is-author-date',
            `refs/remotes/origin/${prepared.baseBranch}`,
          ],
          gitIdentity,
        ),
      ),
      () => abortRebase(settings, prepared),
    ),
    (cause) =>
      Effect.zipRight(
        abortRebase(settings, prepared),
        Effect.fail(
          new SourceControlError({
            category: 'rebase_conflict',
            message: 'source-control publication could not rebase onto the protected base',
            retryable: true,
            worktreePreserved: true,
            cause,
          }),
        ),
      ),
  )

const publishRepository = (
  settings: GitSourceControlSettings,
  issue: Issue,
  prepared: PreparedRepository,
): Effect.Effect<PublicationOutcome, SourceControlError> =>
  Effect.gen(function* () {
    const dirty = (yield* status(settings, 'publish', prepared.workspace)).length > 0
    if (dirty) {
      yield* runGit(settings, 'publish', prepared.workspace.path, ['add', '--all'])
      const commitDate = yield* runGit(settings, 'publish', prepared.workspace.path, [
        'show',
        '-s',
        '--format=%aI',
        'HEAD',
      ])
      yield* runGit(
        settings,
        'publish',
        prepared.workspace.path,
        ['commit', '-m', `sloppenheimer: ${issue.identifier} ${issue.title}`],
        {
          ...gitIdentity,
          GIT_AUTHOR_DATE: commitDate.trim(),
          GIT_COMMITTER_DATE: commitDate.trim(),
        },
      )
    }
    const committedHead = yield* revParse(settings, 'publish', prepared.workspace, 'HEAD')
    if (!dirty && committedHead === prepared.baselineSha) {
      const unchanged: PublicationOutcome = {
        _tag: 'NoChanges',
        branchName: prepared.target.branchName,
        baselineSha: prepared.baselineSha,
      }
      return unchanged
    }

    yield* runGit(settings, 'publish', prepared.workspace.path, [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${prepared.baseBranch}:refs/remotes/origin/${prepared.baseBranch}`,
    ])
    yield* rebaseOntoBase(settings, prepared)
    const headSha = yield* revParse(settings, 'publish', prepared.workspace, 'HEAD')
    const actualRemoteHead = yield* remoteHead(
      settings,
      'publish',
      prepared.workspace,
      prepared.target.branchName,
    )
    if (!sameHead(prepared.expectedRemoteHead, actualRemoteHead)) {
      return yield* Effect.fail(leaseFailure(prepared, actualRemoteHead))
    }
    const expected = Option.getOrElse(prepared.expectedRemoteHead, () => '')
    yield* runGit(settings, 'publish', prepared.workspace.path, [
      'push',
      'origin',
      `HEAD:refs/heads/${prepared.target.branchName}`,
      `--force-with-lease=refs/heads/${prepared.target.branchName}:${expected}`,
    ])
    const published: PublicationOutcome = {
      _tag: 'Published',
      branchName: prepared.target.branchName,
      headSha,
      commitCreated: dirty,
    }
    return published
  })

export const makeGitSourceControl = (settings: GitSourceControlSettings): SourceControlPort => ({
  prepare: (issue, workspace, target) => prepareRepository(settings, issue, workspace, target),
  publish: (issue, prepared) => publishRepository(settings, issue, prepared),
})
