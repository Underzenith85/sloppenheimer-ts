import { writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { afterEach, describe, expect } from 'vitest'
import { makeGitSourceControl } from '@sloppenheimer/adapter-node/source-control.js'
import { makeCandidateSourceControl } from '@sloppenheimer/adapter-node/git-candidate.js'
import { runVerifiedPublication } from '@sloppenheimer/core/core/verified-publication.js'
import { runPostflight } from '@sloppenheimer/core/core/postflight.js'
import { SourceControlError } from '@sloppenheimer/core/domain/errors.js'
import type { Candidate } from '@sloppenheimer/core/ports/candidate.js'
import type {
  PublicationConflict,
  ResolvePublicationConflict,
} from '@sloppenheimer/core/ports/source-control.js'
import { anIssue } from './harness/fixtures.js'
import { makeGitRepository, git, commitFile } from './harness/git-repository.js'

const roots: string[] = []
afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = Effect.gen(function* () {
  const repository = yield* Effect.promise(makeGitRepository)
  roots.push(repository.root)
  const settings = { remoteUrl: repository.remote, baseBranch: 'main', credential: Option.none() }
  const source = makeGitSourceControl(settings)
  const candidates = makeCandidateSourceControl(settings)
  const issue = anIssue()
  const prepared = yield* source.prepare(
    issue,
    { path: repository.workspace, key: 'conflict' },
    { _tag: 'Normal', branchName: 'candidate/conflict' },
  )
  const early = yield* Effect.promise(() =>
    commitFile(
      repository.workspace,
      'README.md',
      'early implementation\n',
      'early conflicting commit',
    ),
  )
  yield* Effect.promise(() =>
    commitFile(repository.workspace, 'README.md', 'final implementation\n', 'later resolution'),
  )
  yield* Effect.promise(() =>
    commitFile(repository.seed, 'README.md', 'protected change\n', 'advance protected base'),
  )
  yield* Effect.promise(() => git(repository.seed, ['push', 'origin', 'main']))
  const conflicts: PublicationConflict[] = []
  const resolve: ResolvePublicationConflict = (conflict) =>
    Effect.gen(function* () {
      conflicts.push(conflict)
      expect(conflict.paths).toContain('README.md')
      expect(
        yield* Effect.promise(() => readFile(join(repository.workspace, 'README.md'), 'utf8')),
      ).toContain('<<<<<<<')
      yield* Effect.promise(() =>
        writeFile(
          join(repository.workspace, 'README.md'),
          conflict.stoppedCommitSha === early
            ? 'early implementation\nprotected change\n'
            : 'final implementation\nprotected change\n',
        ),
      )
    })
  return { repository, source, candidates, issue, prepared, conflicts, resolve }
})
const gate = {
  command: "grep -q 'final implementation' README.md && grep -q 'protected change' README.md",
  timeoutMs: 5_000,
}

describe('publication conflict repair', () => {
  it.live(
    'continues successive conflicts and verifies and publishes exactly the resolved candidate',
    () =>
      Effect.gen(function* () {
        const { repository, source, candidates, issue, prepared, conflicts, resolve } =
          yield* fixture
        const checked: Candidate[] = []
        const outcome = yield* runVerifiedPublication(
          {
            ...source,
            candidates: {
              ...candidates,
              verify: (candidate, configuration, secrets) => {
                checked.push(candidate)
                return candidates.verify(candidate, configuration, secrets)
              },
            },
          },
          issue,
          prepared,
          gate,
          [],
          { resolveConflict: resolve },
        )
        expect(conflicts.length).toBe(2)
        expect(conflicts[0]?.stoppedCommitSha).not.toBe(conflicts[1]?.stoppedCommitSha)
        expect(checked).toHaveLength(1)
        expect(outcome).toMatchObject({ _tag: 'Published', headSha: checked[0]?.headSha })
        expect(
          yield* Effect.promise(() =>
            git(repository.remote, ['rev-parse', 'refs/heads/candidate/conflict']),
          ),
        ).toBe(checked[0]?.headSha)
        expect(
          yield* Effect.promise(() => git(repository.workspace, ['status', '--porcelain'])),
        ).toBe('')
      }),
  )

  it.live(
    'retains the aligned candidate and original lease across a failed push and delivery retry',
    () =>
      Effect.gen(function* () {
        const { repository, source, candidates, issue, prepared, conflicts, resolve } =
          yield* fixture
        const first = yield* runPostflight(
          {
            ...source,
            candidates: {
              ...candidates,
              publish: () =>
                Effect.fail(
                  new SourceControlError({
                    category: 'publication_failed',
                    message: 'transport unavailable',
                    retryable: true,
                    worktreePreserved: true,
                  }),
                ),
            },
          },
          issue,
          prepared,
          gate,
          [],
          Effect.void,
          undefined,
          resolve,
        )
        expect(first._tag).toBe('DeliveryFailed')
        if (first._tag !== 'DeliveryFailed') {
          return
        }
        const retained = first.prepared.retainedCandidate
        expect(retained).toBeDefined()
        expect(first.prepared.baselineSha).toBe(prepared.baselineSha)
        expect(first.prepared.expectedRemoteHead).toEqual(prepared.expectedRemoteHead)
        const retried = yield* runPostflight(source, issue, first.prepared, gate)
        expect(retried).toMatchObject({ _tag: 'Published', headSha: retained?.headSha })
        expect(conflicts).toHaveLength(2)
        expect(
          yield* Effect.promise(() =>
            git(repository.remote, ['rev-parse', 'refs/heads/candidate/conflict']),
          ),
        ).toBe(retained?.headSha)
      }),
  )

  it.live('holds an unchanged conflict without replaying or consuming delivery retries', () =>
    Effect.gen(function* () {
      const { repository, source, issue, prepared } = yield* fixture
      let repairs = 0
      const outcome = yield* runPostflight(
        source,
        issue,
        prepared,
        gate,
        [],
        Effect.void,
        undefined,
        () =>
          Effect.sync(() => {
            repairs += 1
          }),
      )
      expect(repairs).toBe(1)
      expect(outcome).toMatchObject({
        _tag: 'DeliveryFailed',
        failure: { category: 'rebase_conflict', retryable: false, worktreePreserved: true },
      })
      expect(
        yield* Effect.promise(() => git(repository.workspace, ['rev-parse', 'REBASE_HEAD'])),
      ).not.toBe('')
      expect(
        yield* Effect.promise(() =>
          git(repository.workspace, ['diff', '--name-only', '--diff-filter=U']),
        ),
      ).toContain('README.md')
    }),
  )

  it.live('refuses a remote head that moved while the conflict was being repaired', () =>
    Effect.gen(function* () {
      const { repository, source, issue, prepared, resolve } = yield* fixture
      const error = yield* Effect.flip(
        runVerifiedPublication(source, issue, prepared, gate, [], {
          resolveConflict: (conflict) =>
            resolve(conflict).pipe(
              Effect.zipRight(
                Effect.promise(() =>
                  git(repository.seed, ['push', 'origin', 'main:refs/heads/candidate/conflict']),
                ),
              ),
              Effect.asVoid,
            ),
        }),
      )
      expect(error).toMatchObject({ category: 'lease_conflict', retryable: false })
      expect(
        yield* Effect.promise(() =>
          git(repository.remote, ['rev-parse', 'refs/heads/candidate/conflict']),
        ),
      ).toBe(yield* Effect.promise(() => git(repository.seed, ['rev-parse', 'main'])))
    }),
  )

  it.live('rejects a failed final gate after successful conflict repair', () =>
    Effect.gen(function* () {
      const { source, issue, prepared, resolve } = yield* fixture
      const error = yield* Effect.flip(
        runVerifiedPublication(source, issue, prepared, { ...gate, command: 'exit 1' }, [], {
          resolveConflict: resolve,
        }),
      )
      expect(error).toMatchObject({ category: 'verification_failed', retryable: false })
      expect(error.retainedCandidate).toBeDefined()
    }),
  )
})
