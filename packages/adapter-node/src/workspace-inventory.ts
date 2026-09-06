import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { join } from 'node:path'
import { Effect, Option } from 'effect'

import type { CapturedWorkspaceMetadata } from '@sloppenheimer/core/domain/workspace-lease.js'
import {
  containedRunWorkspacePath,
  isLeaseEntry,
  workspaceKey,
} from '@sloppenheimer/core/domain/workspace-containment.js'
import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import { issueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import { realDirectoryExists, reportedAs } from './filesystem.js'
import { leaseIsLive } from './workspace-lease.js'
import { readLease } from './workspace-lease-store.js'

const metadataIn = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  issueEntry: string,
): Effect.Effect<readonly CapturedWorkspaceMetadata[], WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    const issuePath = join(root, issueEntry)
    if (!(yield* realDirectoryExists(fileSystem, issuePath))) {
      return []
    }
    const captured: CapturedWorkspaceMetadata[] = []
    for (const entry of yield* fileSystem.readDirectory(issuePath)) {
      if (!isLeaseEntry(entry)) {
        continue
      }
      const leasePath = join(issuePath, entry)
      const lease = yield* readLease(fileSystem, leasePath)
      if (Option.isNone(lease) || leaseIsLive(lease.value, leasePath)) {
        continue
      }
      const record = lease.value
      const paths = yield* containedRunWorkspacePath(
        root,
        issueIdentifier(record.identifier),
        record.runKey,
      )
      if (
        paths.issueKey !== issueEntry ||
        paths.leasePath !== leasePath ||
        record.runKey !== entry.slice(0, -'.lease'.length) ||
        workspaceKey(issueIdentifier(record.identifier)) !== issueEntry ||
        !(yield* realDirectoryExists(fileSystem, paths.runPath))
      ) {
        continue
      }
      captured.push({
        identifier: issueIdentifier(record.identifier),
        workspace: { path: paths.runPath, key: record.runKey },
        runId: record.runId,
        reason: record.reason,
        retainedAt: record.releasedAt ?? record.acquiredAt,
      })
    }
    return captured
  })

/** Reads only lease records whose identifier reconstructs their exact contained path. */
export const capturedWorkspaceMetadata = (
  fileSystem: FileSystem.FileSystem,
  root: string,
): Effect.Effect<readonly CapturedWorkspaceMetadata[], WorkspaceError> =>
  Effect.gen(function* () {
    if (!(yield* realDirectoryExists(fileSystem, root))) {
      return []
    }
    const entries = yield* fileSystem.readDirectory(root)
    return yield* Effect.map(
      Effect.forEach(entries, (entry) => metadataIn(fileSystem, root, entry), {
        concurrency: 8,
      }),
      (groups) => groups.flat(),
    )
  }).pipe(reportedAs('inspect_failed', 'failed to inventory captured workspace metadata'))
