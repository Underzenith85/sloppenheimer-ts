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
import { alreadyOnRemote, fetchBase, pushUnderLease, rebaseOntoBase } from './git-publication.js'
import { makeCandidateSourceControl } from './git-candidate.js'
import { containedIn, remoteHead, revParse, status } from './git-queries.js'
import { gitIdentity, runGit, type GitSourceControlSettings } from './git-process.js'

export type { GitCredential, GitSourceControlSettings } from './git-process.js'

/**
 * Host Git source control: preparing a run's own workspace from the branch's published head, the
 * exact head of a repair, or the protected base, publishing the agent's work back under an
 * expected-head lease, and putting a branch that fell behind the base back on top of it under the
 * same lease.
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

    yield* fetchBase(settings, prepared)
    yield* rebaseOntoBase(settings, prepared)
    const headSha = yield* revParse(settings, 'publish', prepared.workspace, 'HEAD')
    yield* pushUnderLease(settings, prepared)
    const published: PublicationOutcome = {
      _tag: 'Published',
      branchName: prepared.target.branchName,
      headSha,
      commitCreated: dirty,
    }
    return published
  })

/**
 * The host's own answer to a branch that is behind the protected base: the same rebase and leased
 * push a publication ends with, without the commit a publication begins with.
 *
 * Nothing is asked of the worktree first. The preparation put the branch at its published head with
 * nothing carried over, so there is no work to find, and the question a publication asks -- is this
 * commit already on the remote -- is true by construction and would answer `Published` for a branch
 * this has not moved. What is asked instead is whether the base is already behind HEAD, and it is
 * asked before the rebase rather than by comparing heads afterwards: the rebase rewrites every
 * commit it replays whether or not the base moved, so an unchanged branch would come back with a
 * new head, be pushed, and cost the pull request a review of a change that is the same change.
 */
const rebaseRepository = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
): Effect.Effect<PublicationOutcome, SourceControlError> =>
  Effect.gen(function* () {
    const baseSha = yield* fetchBase(settings, prepared)
    const onBase = yield* containedIn(settings, 'publish', prepared.workspace, baseSha, 'HEAD')
    if (onBase) {
      const unchanged: PublicationOutcome = {
        _tag: 'NoChanges',
        branchName: prepared.target.branchName,
        baselineSha: prepared.baselineSha,
      }
      return unchanged
    }
    yield* rebaseOntoBase(settings, prepared)
    const headSha = yield* revParse(settings, 'publish', prepared.workspace, 'HEAD')
    yield* pushUnderLease(settings, prepared)
    const published: PublicationOutcome = {
      _tag: 'Published',
      branchName: prepared.target.branchName,
      headSha,
      commitCreated: false,
    }
    return published
  })

export const makeGitSourceControl = (settings: GitSourceControlSettings): SourceControlPort => ({
  candidates: makeCandidateSourceControl(settings),
  prepare: (issue, workspace, target) => prepareRepository(settings, issue, workspace, target),
  inspect: (prepared) => inspectRepository(settings, prepared),
  publish: (issue, prepared) => publishRepository(settings, issue, prepared),
  rebase: (_issue, prepared) => rebaseRepository(settings, prepared),
})
