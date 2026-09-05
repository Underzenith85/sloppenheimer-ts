import { Effect } from 'effect'
import { issueId } from '../../domain/domain.js'
import type { SourceControlPort } from '../../ports/source-control.js'
import type { RuntimeCells } from './types.js'
import { ownIssueFiber } from './execution.js'

/** Remote reads run off the mailbox so one unavailable repository cannot block controls or peers. */
export const startPublicationRecovery = (
  cells: RuntimeCells,
  sourceControl: SourceControlPort | null,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const durable = cells.durable
    const recovery = sourceControl?.recovery
    if (durable === undefined || recovery === undefined) {
      return
    }
    const records = yield* durable.snapshot
    const concurrency = yield* Effect.makeSemaphore(4)
    for (const record of records) {
      if (record.status._tag === 'Intervention') {
        yield* ownIssueFiber(
          cells.execution,
          'recovery',
          issueId(record.issueId),
          concurrency.withPermits(1)(durable.reconcilePublication(record.issueId, recovery)),
        )
      }
    }
  })
