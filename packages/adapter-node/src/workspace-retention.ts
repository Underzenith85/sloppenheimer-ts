import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Effect, Option } from 'effect'

import type { HooksConfig } from '@sloppenheimer/core/config/workflow.js'
import type { IssueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import {
  containedWorkspacePath,
  isLeaseEntry,
  leasePathFor,
  leaseStagingPath,
  workspaceKey,
} from '@sloppenheimer/core/domain/workspace-containment.js'
import type { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import {
  workspacesToEvict,
  type RetainedWorkspace,
  type WorkspacePruneReport,
  type WorkspaceRetention,
} from '@sloppenheimer/core/domain/workspace-retention.js'
import { directorySize, pinDirectory, realDirectoryExists, reportedAs } from './filesystem.js'
import { removeFreeRunWorkspace } from './workspace-cleanup.js'
import { leaseIsLive, retainedOwnerIsFinished } from './workspace-lease.js'
import { readLease } from './workspace-lease-store.js'

/**
 * Bounding what an issue that is not finished with keeps on disk: the retained workspaces past
 * the cap are taken, by the same fenced removal terminal cleanup uses, and what is left is counted
 * and measured so the operator sees the growth rather than discovering it from a full disk.
 *
 * Which workspaces go is decided in `domain/workspace-retention.ts`. This module reads the records
 * that rule needs, removes what it names, and measures the rest.
 */

/**
 * The run keys an issue directory holds, from its run directories and its lease records alike —
 * the same reading cleanup takes, so nothing the one can remove is invisible to the other.
 */
const runKeysIn = (entries: readonly string[]): readonly string[] => [
  ...new Set(
    entries.map((entry) => (isLeaseEntry(entry) ? entry.slice(0, -'.lease'.length) : entry)),
  ),
]

/** An issue directory's workspaces that no live run holds, as the pruning rule reads them. */
const retainedWorkspacesIn = (
  fileSystem: FileSystem.FileSystem,
  issuePath: string,
): Effect.Effect<readonly RetainedWorkspace[], WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    const retained: RetainedWorkspace[] = []
    for (const key of runKeysIn(yield* fileSystem.readDirectory(issuePath))) {
      const runPath = yield* containedWorkspacePath(issuePath, key)
      const leasePath = leasePathFor(runPath)
      const lease = yield* readLease(fileSystem, leasePath)
      // A directory with no lease beside it is nobody's: a host killed between taking a record
      // aside and putting it back leaves one, and the staged record is swept later. Cleanup
      // already reads those as free, and a cap that skipped them would leave one on disk per
      // such death, outside both the limit and the count, for as long as the issue stayed open.
      if (Option.isNone(lease)) {
        retained.push({ key, retainedAt: null, runId: null, ownerFinished: true })
        continue
      }
      // Otherwise every workspace no live run holds, which is the retained records and one more:
      // a release whose rewrite failed leaves a `held` record its host has let go of.
      if (!leaseIsLive(lease.value, leasePath)) {
        retained.push({
          key,
          retainedAt: Date.parse(lease.value.releasedAt ?? lease.value.acquiredAt),
          runId: lease.value.runId,
          ownerFinished: retainedOwnerIsFinished(lease.value),
        })
      }
    }
    return retained
  })

/**
 * Keeps the newest retained workspaces of one issue up to `retention.limit`, removes the rest that
 * nobody may still want, and answers with what the issue still holds.
 *
 * Every removal is the fenced one terminal cleanup performs: the record is taken aside first and
 * the decision made again on what was taken, so a run that claimed the name in the meantime keeps
 * its workspace. Like that cleanup, this holds the issue directory still for the whole pass and
 * re-confirms it before each step that removes.
 */
export const pruneIssueWorkspaces = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  root: string,
  identifier: IssueIdentifier,
  retention: WorkspaceRetention,
): Effect.Effect<WorkspacePruneReport, WorkspaceError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const issuePath = yield* containedWorkspacePath(root, workspaceKey(identifier))
      if (!(yield* realDirectoryExists(fileSystem, issuePath))) {
        return { count: 0, bytes: 0, evicted: 0 }
      }
      const stillTheIssueDirectory = yield* pinDirectory(
        fileSystem,
        issuePath,
        'workspace directory',
      )
      const retained = yield* retainedWorkspacesIn(fileSystem, issuePath)
      const evictions = new Set(workspacesToEvict(retained, retention))
      let evicted = 0
      for (const key of evictions) {
        const runPath = yield* containedWorkspacePath(issuePath, key)
        const removed = yield* removeFreeRunWorkspace(
          fileSystem,
          hooks,
          runPath,
          leaseStagingPath(root),
          stillTheIssueDirectory,
        )
        if (removed) {
          evicted += 1
        }
      }
      // What was named for eviction and not removed has been claimed by a run since, and is that
      // run's held workspace now rather than a retained one; so the remainder is measured by what
      // this pass decided to keep.
      let bytes = 0
      let count = 0
      for (const workspace of retained) {
        if (evictions.has(workspace.key)) {
          continue
        }
        yield* stillTheIssueDirectory
        bytes += yield* directorySize(yield* containedWorkspacePath(issuePath, workspace.key))
        count += 1
      }
      return { count, bytes, evicted }
    }),
  ).pipe(reportedAs('remove_failed', 'failed to prune workspaces'))
