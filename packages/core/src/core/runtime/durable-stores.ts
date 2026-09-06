import { issueId } from '../../domain/domain.js'
import { Effect } from 'effect'
import type { DurableHost } from '../durable/live-journal.js'
import type { RestoredState } from './store.js'
import type { WorkspaceManagerPort } from '../../ports/workspace.js'
import { WorkflowError } from '../../domain/errors.js'

/** Legacy lease discovery fails startup closed; imported records never manufacture candidate facts. */
export const importCapturedWorkspaces = (
  durable: DurableHost,
  workspaces: WorkspaceManagerPort,
): Effect.Effect<void, WorkflowError> => {
  const inventory = workspaces.capturedMetadata
  return inventory.pipe(
    Effect.mapError(
      (cause) =>
        new WorkflowError({
          category: 'invalid_config',
          message: 'retained workspace metadata could not be imported safely',
          cause,
        }),
    ),
    Effect.flatMap((metadata) => durable.recordWorkspaces(metadata)),
  )
}

/** SQLite wins after migration. The legacy file is retained unchanged for operator rollback. */
export const restoreDurableHandoffs = (
  durable: DurableHost,
  restored: RestoredState,
): Effect.Effect<RestoredState> =>
  Effect.gen(function* () {
    const known = new Set(
      (yield* durable.snapshot)
        .filter((record) => record.handoff !== undefined)
        .map((record) => record.issueId),
    )
    yield* durable.recordHandoffs(
      restored.handoffs.filter((handoff) => !known.has(handoff.issueId)),
    )
    yield* durable.recordCompletions(restored.completions)
    const records = yield* durable.snapshot
    const completions = records.flatMap((record) =>
      record.completion === undefined
        ? []
        : [{ ...record.completion, issueId: issueId(record.issueId) }],
    )
    const handoffs = (yield* durable.snapshot).flatMap((record) =>
      record.handoff === undefined || record.status._tag === 'Completed' ? [] : [record.handoff],
    )
    return { ...restored, handoffs, completions }
  })
