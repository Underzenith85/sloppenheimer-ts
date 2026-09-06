import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Option } from 'effect'

import { SourceControlError } from '@sloppenheimer/core/domain/errors.js'
import type { SourceControlRecoveryPort } from '@sloppenheimer/core/ports/source-control.js'
import { runGit, type GitSourceControlSettings } from './git-process.js'

export const repositoryIdentity = (settings: GitSourceControlSettings): string =>
  createHash('sha256').update(settings.remoteUrl).digest('hex')

const recoveryFailure = (cause: unknown): SourceControlError =>
  new SourceControlError({
    category: 'publication_failed',
    message: 'remote publication observation failed',
    retryable: true,
    worktreePreserved: true,
    cause,
  })

/** A disposable directory prevents Git from consulting an orphaned checkout's config or objects. */
const observeHead = (
  settings: GitSourceControlSettings,
  branchName: string,
): Effect.Effect<Option.Option<string>, SourceControlError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => mkdtemp(join(tmpdir(), 'sloppenheimer-observe-')),
          catch: recoveryFailure,
        }),
        (path) =>
          Effect.ignore(Effect.tryPromise(() => rm(path, { recursive: true, force: true }))),
      )
      const output = yield* runGit(
        { ...settings, timeoutMs: Math.min(settings.timeoutMs ?? 30_000, 30_000) },
        'publish',
        directory,
        ['ls-remote', '--refs', '--', settings.remoteUrl, 'refs/heads/' + branchName],
        {
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_COMMON_DIR: undefined,
          GIT_CONFIG_COUNT: '0',
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_CONFIG: undefined,
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_NOSYSTEM: '1',
        },
      ).pipe(Effect.mapError(recoveryFailure))
      const lines = output
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
      if (lines.length === 0) {
        return Option.none()
      }
      const fields = lines[0]?.split('\t')
      const head = fields?.[0]
      if (
        lines.length !== 1 ||
        head === undefined ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head) ||
        fields?.[1] !== 'refs/heads/' + branchName ||
        fields.length !== 2
      ) {
        return yield* Effect.fail(recoveryFailure('invalid exact-ref response'))
      }
      return Option.some(head)
    }),
  )

export const makePublicationRecovery = (
  settings: GitSourceControlSettings,
): SourceControlRecoveryPort => ({
  repositoryIdentity: repositoryIdentity(settings),
  observeHead: (branchName) => observeHead(settings, branchName),
})
