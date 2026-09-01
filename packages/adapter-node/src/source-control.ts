import { Effect, Option } from 'effect'

import type { Issue, Workspace } from '@sloppenheimer/core/domain/domain.js'
import { SourceControlError } from '@sloppenheimer/core/domain/errors.js'
import type {
  PreparedRepository,
  PublicationOutcome,
  SourceControlPort,
  SourceControlTarget,
  WorktreeInspection,
} from '@sloppenheimer/core/ports/source-control.js'
import {
  containedIn,
  currentBranch,
  currentHead,
  remoteHead,
  revParse,
  status,
} from './git-queries.js'
import { gitIdentity, runGit, type GitSourceControlSettings } from './git-process.js'

export type { GitCredential, GitSourceControlSettings } from './git-process.js'

/**
 * Host Git source control: preparing a workspace's repository from the protected base or from an
 * exact repair head, and publishing the agent's work back under an expected-head lease.
 *
 * How a git invocation is run, authenticated, and read when it fails lives in `git-process.ts`;
 * this module decides only which invocations to make and what their output means.
 */

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
 * The head a repair must start from, or `none` for normal work, which starts from the protected
 * base instead. Absence here chooses the next branch rather than crossing a data boundary, so it is
 * an `Option` and never leaves this module.
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
 * still dirty — and the next preparation reads exactly that as unfinished agent work to preserve,
 * publishing an edit no agent made. The two commands are local and bounded, so an interruption
 * waits them out rather than settling halfway through.
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
 * Refuses a preserved workspace the remote branch has moved on from independently.
 *
 * Publication rebases onto the protected base and force-pushes under a lease read at preparation
 * time, so a divergence that predates the preparation satisfies that lease trivially: the push
 * would delete the commits the remote holds and this workspace does not. The lease answers whether
 * the branch moved while the turn ran, never whether the retained work was built on what the branch
 * carries now — and after a restart those are different questions, because the host was not there
 * for the interval the lease covers.
 *
 * Retained rather than reset, and typed retryable: both sides hold real work, and the one thing
 * that must not happen is either being thrown away to make the other publishable.
 */
const refuseDivergedBranch = (
  settings: GitSourceControlSettings,
  workspace: Workspace,
  target: SourceControlTarget,
  observedRemoteHead: Option.Option<string>,
  head: Option.Option<string>,
): Effect.Effect<void, SourceControlError> =>
  Effect.gen(function* () {
    if (Option.isNone(observedRemoteHead) || Option.isNone(head)) {
      return
    }
    const carried = yield* containedIn(
      settings,
      'prepare',
      workspace,
      observedRemoteHead.value,
      head.value,
    )
    if (carried) {
      return
    }
    yield* Effect.fail(
      new SourceControlError({
        category: 'lease_conflict',
        message: `remote branch ${target.branchName} carries work this workspace does not (remote ${observedRemoteHead.value}, retained ${head.value})`,
        retryable: true,
        worktreePreserved: true,
      }),
    )
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
    const repairHead = yield* expectedRepairHead(target, observedRemoteHead)
    // Fetched whenever the remote has this branch, not only for a repair that starts from it: the
    // inspection decides whether a retained commit is genuinely unpublished by asking whether the
    // remote head already contains it, and it cannot ask about a commit it does not have.
    if (Option.isSome(observedRemoteHead)) {
      yield* runGit(settings, 'prepare', workspace.path, [
        'fetch',
        '--no-tags',
        'origin',
        `+refs/heads/${target.branchName}:refs/remotes/origin/${target.branchName}`,
      ])
    }

    const branch = yield* currentBranch(settings, 'prepare', workspace)
    const head = yield* currentHead(settings, 'prepare', workspace)
    const dirty = (yield* status(settings, 'prepare', workspace)).length > 0
    // A repair starts from the head it holds a lease on. A normal target starts from whatever its
    // branch already carries, and only from the protected base when the branch does not exist yet:
    // the commits on it are this issue's own published work, and rebuilding the workspace from the
    // base would have the next publication force-push over them under a lease that matches.
    const baselineSha = Option.getOrElse(repairHead, () =>
      Option.getOrElse(observedRemoteHead, () => baseSha),
    )
    // Measured against what the remote already has, exactly as the inspection measures it. A
    // workspace the branch has moved past holds a commit the remote has since built on: preserving
    // it would hand the next agent a stale head, and publishing from there force-pushes over the
    // commits that arrived in the meantime.
    const delivered = Option.getOrElse(observedRemoteHead, () => baselineSha)
    const unpublishedCommit = Option.isSome(head)
      ? head.value !== delivered &&
        !(yield* containedIn(settings, 'prepare', workspace, head.value, delivered))
      : false
    const preserve = Option.contains(branch, target.branchName) && (dirty || unpublishedCommit)
    if (preserve) {
      yield* refuseDivergedBranch(settings, workspace, target, observedRemoteHead, head)
    } else {
      yield* resetToBaseline(settings, workspace, target.branchName, baselineSha)
    }
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

/**
 * Reads the worktree against what the preparation recorded, without changing anything.
 *
 * Both halves of "there is work here" are asked separately, because they fail differently: an
 * uncommitted edit is what a turn normally leaves, while a commit the remote does not have is what
 * a publication that failed after committing left behind, and the second must not read as an empty
 * worktree just because the first is now clean.
 *
 * The commit is measured by containment rather than by equality: a workspace left behind by a host
 * that was down while the branch advanced holds a commit the remote already has and has since
 * built on, and reading that as unpublished work would republish it under a lease that matches —
 * overwriting whatever arrived in the meantime. Ahead means the remote does not contain it.
 */
const inspectRepository = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
): Effect.Effect<WorktreeInspection, SourceControlError> =>
  Effect.gen(function* () {
    const porcelain = yield* status(settings, 'publish', prepared.workspace)
    const dirtyFileCount = porcelain.split('\n').filter((line) => line.trim().length > 0).length
    const headSha = yield* revParse(settings, 'publish', prepared.workspace, 'HEAD')
    const delivered = Option.getOrElse(prepared.expectedRemoteHead, () => prepared.baselineSha)
    const committedAhead =
      headSha !== delivered &&
      !(yield* containedIn(settings, 'publish', prepared.workspace, headSha, delivered))
    return dirtyFileCount === 0 && !committedAhead
      ? { _tag: 'Clean', headSha }
      : { _tag: 'Changed', headSha, dirtyFileCount, committedAhead }
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

/**
 * Whether the branch this would publish to already carries the commit in the workspace.
 *
 * Containment rather than equality, and against the branch as the remote has it now rather than as
 * the preparation recorded it: a push that landed may since have had commits built on top of it,
 * and the work is delivered either way. The branch ref is fetched first, because the question
 * cannot be asked about a commit the workspace does not have.
 */
const alreadyOnRemote = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
  committedHead: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const fetched = yield* Effect.either(
      runGit(settings, 'publish', prepared.workspace.path, [
        'fetch',
        '--no-tags',
        'origin',
        `+refs/heads/${prepared.target.branchName}:refs/remotes/origin/${prepared.target.branchName}`,
      ]),
    )
    if (fetched._tag === 'Left') {
      // No such branch on the remote, or the remote could not be reached. Neither says the work is
      // delivered, and assuming it was would discard a publication that never happened.
      return false
    }
    return yield* containedIn(
      settings,
      'publish',
      prepared.workspace,
      committedHead,
      `refs/remotes/origin/${prepared.target.branchName}`,
    )
  })

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

    // Asked before the rebase, because the rebase is what would make the question unanswerable: the
    // most likely way to arrive here twice is a push the remote accepted and the client did not see
    // succeed, and a protected base that has moved since rewrites the very commit the branch is
    // carrying. Answering `Published` makes the retry idempotent; leaving it to the lease check
    // would reject every attempt against a tip that holds this work already, spend the delivery
    // budget and hand the agent back what is on the remote.
    const delivered = yield* alreadyOnRemote(settings, prepared, committedHead)
    if (delivered) {
      const already: PublicationOutcome = {
        _tag: 'Published',
        branchName: prepared.target.branchName,
        headSha: committedHead,
        commitCreated: dirty,
      }
      return already
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
  inspect: (prepared) => inspectRepository(settings, prepared),
  publish: (issue, prepared) => publishRepository(settings, issue, prepared),
})
