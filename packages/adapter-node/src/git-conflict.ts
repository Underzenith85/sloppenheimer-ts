/**
 * Continue the host's paused rebase after file-only repair. Never restart its original sequence:
 * the index and sequencer belong to the leased workspace until publication or an explicit hold.
 * Failed and interrupted repairs retain that state for diagnosis, not automatic delivery replay.
 */
import { Effect } from 'effect'
import { stat } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { SourceControlError } from '@sloppenheimer/core/domain/errors.js'
import type {
  PreparedRepository,
  PublicationConflict,
  ResolvePublicationConflict,
} from '@sloppenheimer/core/ports/source-control.js'
import { gitIdentity, runGit, type GitSourceControlSettings } from './git-process.js'
import { revParse } from './git-queries.js'

const retainedFailure = (message: string): SourceControlError =>
  new SourceControlError({
    category: 'rebase_conflict',
    message,
    retryable: false,
    worktreePreserved: true,
  })

const conflictState = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
  originalHeadSha: string,
  baseSha: string,
): Effect.Effect<PublicationConflict, SourceControlError> =>
  Effect.gen(function* () {
    const paths = yield* runGit(settings, 'publish', prepared.workspace.path, [
      'diff',
      '--name-only',
      '--diff-filter=U',
      '-z',
    ])
    return {
      originalHeadSha,
      baseSha,
      headSha: yield* revParse(settings, 'publish', prepared.workspace, 'HEAD'),
      stoppedCommitSha: yield* revParse(settings, 'publish', prepared.workspace, 'REBASE_HEAD'),
      paths: paths.split('\0').filter((path) => path.length > 0),
    }
  })

const repairConflict = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
  conflict: PublicationConflict,
  resolve: ResolvePublicationConflict,
): Effect.Effect<void, SourceControlError> =>
  Effect.gen(function* () {
    yield* resolve(conflict)
    const head = yield* revParse(settings, 'publish', prepared.workspace, 'HEAD')
    const stopped = yield* revParse(settings, 'publish', prepared.workspace, 'REBASE_HEAD')
    if (head !== conflict.headSha || stopped !== conflict.stoppedCommitSha) {
      return yield* Effect.fail(
        retainedFailure('Conflict repair changed host-owned rebase identity'),
      )
    }
    // diff --check detects remaining conflict markers before staging would hide the unmerged index.
    yield* runGit(settings, 'publish', prepared.workspace.path, ['diff', '--check']).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlError({
            category: 'rebase_conflict',
            message:
              'Conflict repair left unresolved markers or invalid whitespace: ' + cause.message,
            retryable: false,
            worktreePreserved: true,
            cause,
          }),
      ),
    )
    yield* runGit(settings, 'publish', prepared.workspace.path, ['add', '--all'])
  })

export const rebaseWithRepair = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
  resolve: ResolvePublicationConflict,
): Effect.Effect<void, SourceControlError> =>
  Effect.gen(function* () {
    const originalHeadSha = yield* revParse(settings, 'publish', prepared.workspace, 'HEAD')
    const baseSha = yield* revParse(
      settings,
      'publish',
      prepared.workspace,
      `refs/remotes/origin/${prepared.baseBranch}`,
    )
    const advance = (args: readonly string[]): Effect.Effect<void, SourceControlError> =>
      runGit(settings, 'publish', prepared.workspace.path, args, {
        ...gitIdentity,
        GIT_EDITOR: 'true',
      }).pipe(
        Effect.asVoid,
        Effect.catchAll((failure) => {
          if (failure.category !== 'rebase_conflict') {
            return Effect.fail(failure)
          }
          return Effect.gen(function* () {
            const conflict = yield* conflictState(settings, prepared, originalHeadSha, baseSha)
            yield* repairConflict(settings, prepared, conflict, resolve)
            yield* advance(['rebase', '--continue'])
          })
        }),
      )
    yield* advance(['rebase', '--committer-date-is-author-date', baseSha]).pipe(
      // The sequencer may have advanced even when Git failed for a transport/process reason.
      // It can only be continued explicitly, never through ordinary publication retry.
      Effect.mapError(
        (cause) =>
          new SourceControlError({
            category: cause.category,
            message: cause.message,
            retryable: false,
            worktreePreserved: true,
            cause,
          }),
      ),
    )
  })

/** A held sequencer needs explicit repair, never ordinary checkpointing or a fresh rebase. */
export const assertNoRebase = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
): Effect.Effect<void, SourceControlError> =>
  Effect.gen(function* () {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const path = yield* runGit(settings, 'publish', prepared.workspace.path, [
        'rev-parse',
        '--git-path',
        name,
      ])
      const state = yield* Effect.tryPromise({
        try: () =>
          stat(resolvePath(prepared.workspace.path, path.trim())).catch((cause: unknown) => {
            if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
              return null
            }
            throw cause
          }),
        catch: (cause) =>
          new SourceControlError({
            category: 'publication_failed',
            message: 'Could not inspect host rebase state',
            retryable: false,
            worktreePreserved: true,
            cause,
          }),
      })
      if (state !== null) {
        const stopped = yield* Effect.either(
          runGit(settings, 'publish', prepared.workspace.path, [
            'rev-parse',
            '--verify',
            '--quiet',
            'REBASE_HEAD',
          ]),
        )
        if (stopped._tag === 'Left') {
          return yield* Effect.fail(
            new SourceControlError({
              category: 'publication_failed',
              message: 'Existing rebase metadata requires reconciliation before publication',
              retryable: false,
              worktreePreserved: true,
            }),
          )
        }
        return yield* Effect.fail(
          retainedFailure(
            'A paused publication rebase is retained; reconcile its conflict before retrying delivery',
          ),
        )
      }
    }
  })
