import { Effect, Option } from 'effect'

import { SourceControlError } from '@sloppenheimer/core/domain/errors.js'
import type { PreparedRepository } from '@sloppenheimer/core/ports/source-control.js'
import { containedIn, remoteHead, revParse } from './git-queries.js'
import { gitIdentity, runGit, type GitSourceControlSettings } from './git-process.js'

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

/**
 * Puts HEAD on top of the fetched base, leaving no rebase state behind however it ends.
 *
 * The failure is passed through as the git reader classified it rather than re-wrapped: a content
 * conflict arrives as `rebase_conflict`, and a rebase git refused to start or finish -- a stale
 * `rebase-merge` directory, a lock, a spawn failure -- keeps the publication category and its
 * retryability, so a caller that treats a conflict as final does not treat a transient failure as
 * final with it.
 */
export const rebaseOntoBase = (
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
    (failure) => Effect.zipRight(abortRebase(settings, prepared), Effect.fail(failure)),
  )

/**
 * Whether the branch this would publish to already carries the commit in the workspace.
 *
 * Containment rather than equality, and against the branch as the remote has it now rather than as
 * the preparation recorded it: a push that landed may since have had commits built on top of it,
 * and the work is delivered either way. The branch ref is fetched first, because the question
 * cannot be asked about a commit the workspace does not have.
 */
export const alreadyOnRemote = (
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

/**
 * Brings the protected base up to date and answers its head. The preparation's copy is as old as
 * the preparation, and what a branch is put on top of is the base as the remote has it now.
 */
export const fetchBase = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
): Effect.Effect<string, SourceControlError> =>
  runGit(settings, 'publish', prepared.workspace.path, [
    'fetch',
    '--no-tags',
    'origin',
    `+refs/heads/${prepared.baseBranch}:refs/remotes/origin/${prepared.baseBranch}`,
  ]).pipe(
    Effect.zipRight(
      revParse(
        settings,
        'publish',
        prepared.workspace,
        `refs/remotes/origin/${prepared.baseBranch}`,
      ),
    ),
  )

/**
 * Pushes HEAD to the target branch, provided the branch is still where the preparation found it.
 * The lease is read once here and enforced again by git: the read is what turns a moved branch into
 * a typed refusal rather than a rejected push.
 */
export const pushUnderLease = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
  headSha = 'HEAD',
): Effect.Effect<void, SourceControlError> =>
  Effect.gen(function* () {
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
      `${headSha}:refs/heads/${prepared.target.branchName}`,
      `--force-with-lease=refs/heads/${prepared.target.branchName}:${expected}`,
    ])
  })
