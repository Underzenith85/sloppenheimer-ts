import { issueId } from '../../domain/domain.js'
import { Effect } from 'effect'
import type { DurableHost } from '../durable/live-journal.js'
import type { RestoredState } from './store.js'

/** SQLite wins after migration. The legacy file is retained unchanged for operator rollback. */
export const restoreDurableHandoffs = (
  durable: DurableHost | undefined,
  restored: RestoredState,
): Effect.Effect<RestoredState> =>
  Effect.gen(function* () {
    if (durable === undefined) {
      return restored
    }
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
