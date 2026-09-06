import { FileSystem } from '@effect/platform'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { Effect } from 'effect'

import type { Workspace } from '@sloppenheimer/core/domain/domain.js'
import type { HooksConfig } from '@sloppenheimer/core/config/workflow.js'
import { leaseStagingPath } from '@sloppenheimer/core/domain/workspace-containment.js'
import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import { pinDirectory, realDirectoryExists, reportedAs } from './filesystem.js'
import { processWitnessDirectory, witnessedProcessesStopped } from './process-witness.js'
import { removeFreeRunWorkspace } from './workspace-cleanup.js'

/** Validates persisted workspace provenance and returns the root that record captured. */
export const capturedWorkspaceRoot = (
  workspace: Workspace,
): Effect.Effect<string, WorkspaceError> =>
  !isAbsolute(workspace.path) ||
  resolve(workspace.path) !== workspace.path ||
  basename(workspace.path) !== workspace.key ||
  !workspace.key.startsWith('run-')
    ? Effect.fail(
        new WorkspaceError({
          category: 'invalid_path',
          message: 'Captured operation requires a canonical run workspace path',
        }),
      )
    : Effect.succeed(dirname(dirname(workspace.path)))

/** Cleanup follows captured provenance; reload never redirects it to the new configured root. */
export const removeCapturedWorkspace = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  workspace: Workspace,
): Effect.Effect<void, WorkspaceError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* capturedWorkspaceRoot(workspace)
      const issuePath = dirname(workspace.path)
      if (
        !(yield* witnessedProcessesStopped(
          fileSystem,
          processWitnessDirectory(root, workspace.path),
        ))
      ) {
        return yield* Effect.fail(
          new WorkspaceError({
            category: 'lease_conflict',
            message: 'Process termination is unconfirmed; retained workspace cannot be removed',
          }),
        )
      }
      if (!(yield* realDirectoryExists(fileSystem, issuePath))) {
        return
      }
      const stillTheDirectory = yield* pinDirectory(
        fileSystem,
        issuePath,
        'captured workspace parent',
      )
      const removed = yield* removeFreeRunWorkspace(
        fileSystem,
        hooks,
        workspace.path,
        leaseStagingPath(root),
        stillTheDirectory,
      )
      if (!removed) {
        return yield* Effect.fail(
          new WorkspaceError({ category: 'lease_conflict', message: 'Workspace remains leased' }),
        )
      }
    }),
  ).pipe(reportedAs('remove_failed', 'Captured workspace cleanup failed'))
