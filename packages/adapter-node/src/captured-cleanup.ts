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

/** Cleanup follows captured provenance; reload never redirects it to the new configured root. */
export const removeCapturedWorkspace = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  workspace: Workspace,
): Effect.Effect<void, WorkspaceError> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (
        !isAbsolute(workspace.path) ||
        resolve(workspace.path) !== workspace.path ||
        basename(workspace.path) !== workspace.key ||
        !workspace.key.startsWith('run-')
      ) {
        return yield* Effect.fail(
          new WorkspaceError({
            category: 'invalid_path',
            message: 'Captured cleanup requires a canonical run workspace path',
          }),
        )
      }
      const issuePath = dirname(workspace.path)
      const root = dirname(issuePath)
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
