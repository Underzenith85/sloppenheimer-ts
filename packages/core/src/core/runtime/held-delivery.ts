import { Effect, Ref } from 'effect'

import { currentInstant } from '../../support/clock.js'
import { recordPublication } from '../../telemetry.js'
import * as Transitions from '../transitions.js'
import type { DeliveryRequest, RuntimeCells } from './types.js'

/** Keep the candidate and issue claim, without spending retries on unchanged verification inputs. */
export const holdDelivery = (
  cells: RuntimeCells,
  request: DeliveryRequest,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const observedAt = yield* currentInstant
    yield* Ref.update(cells.state, (current) =>
      Transitions.updateDetail(
        Transitions.scheduleDelivery(current, {
          ...request,
          dueAt: observedAt.getTime(),
          observedAt,
          publishingSince: null,
          armed: false,
        }),
        request.issue.id,
        (record) =>
          recordPublication(record, observedAt, {
            status: 'failed',
            branch: request.prepared.target.branchName,
            baselineSha: request.prepared.baselineSha,
            category: request.failure.category,
            attempts: request.attempt,
            message: `${request.failure.message}. Candidate retained; resolve the failure, then resume delivery.`,
          }),
      ),
    )
    return true
  })
