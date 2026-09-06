import { Clock, Effect, Ref } from 'effect'

import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { CapturedWorkspaceMetadata } from '../../domain/workspace-lease.js'

const legacyWorkspaceId = (metadata: CapturedWorkspaceMetadata): string =>
  `legacy-workspace:${encodeURIComponent(metadata.identifier)}:${encodeURIComponent(metadata.workspace.key)}`

/** Imports provenance only. A legacy lease contains no trustworthy repository or candidate SHA. */
export const migratedWorkspace = (
  metadata: CapturedWorkspaceMetadata,
  now: number,
): DurableWorkflow => ({
  version: 1,
  issueId: legacyWorkspaceId(metadata),
  identifier: metadata.identifier,
  objective: `Recover retained workspace ${metadata.workspace.key}`,
  revision: 0,
  intent: 'paused',
  verificationRequired: false,
  status: {
    _tag: 'Intervention',
    reason: 'Legacy retained workspace has no durable candidate evidence; inspect or remove it.',
  },
  artifact: null,
  cleanup: {
    workspacePath: metadata.workspace.path,
    workspaceKey: metadata.workspace.key,
    state: 'intervention',
    attempts: 0,
    dueAt: now,
    reason: metadata.reason ?? 'Imported from retained legacy workspace metadata',
  },
  codingAttempts: 0,
  repairAttempts: 0,
  maximumCodingAttempts: 3,
  maximumRepairAttempts: 3,
  budgetDeadline: now,
  lastProgressAt: Date.parse(metadata.retainedAt),
  lastFailureSignature: null,
  repeatedFailures: 0,
  updatedAt: now,
})

export const recordWorkspaces = (
  records: Ref.Ref<ReadonlyMap<string, DurableWorkflow>>,
  semaphore: Effect.Semaphore,
  persist: (next: DurableWorkflow, expected: number | null) => Effect.Effect<void>,
  metadata: readonly CapturedWorkspaceMetadata[],
): Effect.Effect<void> =>
  Effect.forEach(
    metadata,
    (workspace) =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(records)
          const alreadyKnown = [...current.values()].some(
            (record) =>
              record.artifact?.workspacePath === workspace.workspace.path ||
              record.cleanup?.workspacePath === workspace.workspace.path,
          )
          if (!alreadyKnown) {
            yield* persist(migratedWorkspace(workspace, yield* Clock.currentTimeMillis), null)
          }
        }),
      ),
    { discard: true },
  )
