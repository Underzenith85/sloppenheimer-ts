import { it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { describe, expect } from 'vitest'

import { issueId, issueIdentifier, type Issue } from '@sloppenheimer/core/domain/domain.js'
import { SourceControlError } from '@sloppenheimer/core/domain/errors.js'
import { runPostflight } from '@sloppenheimer/core/core/postflight.js'
import type {
  PreparedRepository,
  SourceControlPort,
} from '@sloppenheimer/core/ports/source-control.js'
import { anIssue } from '../harness/fixtures.js'

/**
 * The postflight, in isolation from everything that acts on its verdict.
 *
 * Every case here is one the orchestrator used to be unable to tell apart, because it read the
 * agent's turn status and the remote head and nothing else. What the host saw in the workspace is
 * the whole subject, so these state it directly.
 */

const issue: Issue = anIssue({
  id: issueId('167'),
  identifier: issueIdentifier('example/sloppenheimer#167'),
  title: 'Separate turn completion from publication',
})

const prepared: PreparedRepository = {
  workspace: { path: '/workspaces/issue-167', key: 'issue-167', createdNow: false },
  target: { _tag: 'Normal', branchName: 'sloppenheimer/issue-167' },
  baseBranch: 'main',
  baseSha: 'base-sha',
  baselineSha: 'base-sha',
  expectedRemoteHead: Option.none(),
}

/** A port that refuses every call it is not given, so a test says only what it is about. */
const sourceControl = (overrides: Partial<SourceControlPort>): SourceControlPort => ({
  prepare: () => Effect.die('prepare is not part of the postflight'),
  inspect: () => Effect.die('the test did not state an inspection'),
  publish: () => Effect.die('the test did not state a publication'),
  ...overrides,
})

const publicationFailure = (
  overrides: Partial<ConstructorParameters<typeof SourceControlError>[0]> = {},
): SourceControlError =>
  new SourceControlError({
    category: 'publication_failed',
    message: 'push rejected',
    retryable: true,
    worktreePreserved: true,
    ...overrides,
  })

describe('postflight after a settled turn', (): void => {
  it.effect('reports a clean worktree without asking the remote anything', () =>
    Effect.gen(function* () {
      let published = 0
      const outcome = yield* runPostflight(
        sourceControl({
          inspect: () => Effect.succeed({ _tag: 'Clean', headSha: 'base-sha' }),
          publish: () => {
            published += 1
            return Effect.die('a clean worktree must not be published')
          },
        }),
        issue,
        prepared,
      )

      expect(outcome).toEqual({
        _tag: 'NoChanges',
        branchName: 'sloppenheimer/issue-167',
        baselineSha: 'base-sha',
      })
      expect(published).toBe(0)
    }),
  )

  it.effect('publishes a dirty worktree and records the commit it produced', () =>
    Effect.gen(function* () {
      const outcome = yield* runPostflight(
        sourceControl({
          inspect: () =>
            Effect.succeed({
              _tag: 'Changed',
              headSha: 'base-sha',
              dirtyFileCount: 3,
              committedAhead: false,
            }),
          publish: () =>
            Effect.succeed({
              _tag: 'Published',
              branchName: 'sloppenheimer/issue-167',
              headSha: 'delivered-sha',
              commitCreated: true,
            }),
        }),
        issue,
        prepared,
      )

      expect(outcome).toEqual({
        _tag: 'Published',
        branchName: 'sloppenheimer/issue-167',
        baselineSha: 'base-sha',
        headSha: 'delivered-sha',
        commitCreated: true,
      })
    }),
  )

  it.effect('reports a failed publication as a delivery, keeping what a retry needs', () =>
    Effect.gen(function* () {
      const outcome = yield* runPostflight(
        sourceControl({
          inspect: () =>
            Effect.succeed({
              _tag: 'Changed',
              headSha: 'local-commit',
              dirtyFileCount: 0,
              committedAhead: true,
            }),
          publish: () => Effect.fail(publicationFailure({ category: 'lease_conflict' })),
        }),
        issue,
        prepared,
      )

      // The whole point of the separation: work exists, it is not on the remote, and the record
      // says so in terms a retry can act on without the agent running again.
      expect(outcome).toMatchObject({
        _tag: 'DeliveryFailed',
        branchName: 'sloppenheimer/issue-167',
        changedFileCount: 0,
        failure: {
          category: 'lease_conflict',
          message: 'push rejected',
          retryable: true,
          worktreePreserved: true,
        },
        prepared,
      })
    }),
  )

  it.effect('reports an inspection that failed as a delivery of an unknown size', () =>
    Effect.gen(function* () {
      const outcome = yield* runPostflight(
        sourceControl({
          inspect: () =>
            Effect.fail(
              publicationFailure({
                category: 'invalid_repository',
                message: 'the worktree could not be read',
                retryable: false,
                worktreePreserved: true,
              }),
            ),
        }),
        issue,
        prepared,
      )

      expect(outcome).toMatchObject({
        _tag: 'DeliveryFailed',
        // Nothing is claimed about how much work there is, because nothing was read.
        changedFileCount: null,
        failure: { category: 'invalid_repository', retryable: false },
      })
    }),
  )

  it.effect('never fails, so a publication problem cannot end the run as an agent failure', () =>
    Effect.gen(function* () {
      const outcome = yield* runPostflight(
        sourceControl({
          inspect: () =>
            Effect.succeed({
              _tag: 'Changed',
              headSha: 'base-sha',
              dirtyFileCount: 1,
              committedAhead: false,
            }),
          publish: () => Effect.fail(publicationFailure({ category: 'authentication_failed' })),
        }),
        issue,
        prepared,
      )

      expect(outcome._tag).toBe('DeliveryFailed')
    }),
  )
})
