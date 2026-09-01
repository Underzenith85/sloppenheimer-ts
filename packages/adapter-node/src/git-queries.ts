import { Effect, Option } from 'effect'

import type { Workspace } from '@sloppenheimer/core/domain/domain.js'
import type { SourceControlError } from '@sloppenheimer/core/domain/errors.js'

import { runGit, type GitOperation, type GitSourceControlSettings } from './git-process.js'

/**
 * What the host asks a repository about, as opposed to what it does to one.
 *
 * Every function here is a read: a ref resolved, a branch named, a worktree's dirtiness, whether
 * one commit is already in another. They are separated from `source-control.ts` because that module
 * is about the decisions — what to prepare from, what to publish, what to refuse — and these are
 * the questions those decisions are made of.
 */

export const remoteHead = (
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

export const revParse = (
  settings: GitSourceControlSettings,
  operation: GitOperation,
  workspace: Workspace,
  revision: string,
): Effect.Effect<string, SourceControlError> =>
  Effect.map(runGit(settings, operation, workspace.path, ['rev-parse', revision]), (value) =>
    value.trim(),
  )

export const status = (
  settings: GitSourceControlSettings,
  operation: GitOperation,
  workspace: Workspace,
): Effect.Effect<string, SourceControlError> =>
  runGit(settings, operation, workspace.path, ['status', '--porcelain=v1', '--untracked-files=all'])

/**
 * Whether `candidate` is already contained in `reference`, so it carries nothing that one lacks.
 *
 * A failure is read as "not contained": the caller acts on that by treating the commit as work,
 * and a commit that cannot be compared is safer inspected than assumed delivered.
 */
export const containedIn = (
  settings: GitSourceControlSettings,
  operation: GitOperation,
  workspace: Workspace,
  candidate: string,
  reference: string,
): Effect.Effect<boolean> =>
  Effect.map(
    Effect.either(
      runGit(settings, operation, workspace.path, [
        'merge-base',
        '--is-ancestor',
        candidate,
        reference,
      ]),
    ),
    (outcome) => outcome._tag === 'Right',
  )
