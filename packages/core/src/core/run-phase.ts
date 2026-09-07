import { Effect, Ref } from 'effect'

import type { IssueId } from '../domain/domain.js'
import { currentInstant } from '../support/clock.js'
import { recordPostflightStarted } from '../telemetry.js'
import type { OrchestratorContext } from './runtime/types.js'
import * as Transitions from './transitions.js'

/** Complete the pure transition before launching work; a parked mailbox owns no acknowledgement. */
export const enterRunPhase = (
  context: Pick<OrchestratorContext, 'state'>,
  issueId: IssueId,
  runId: number,
  phase: 'Agent' | 'Postflight' | 'ConflictRepair',
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const startedAt = yield* currentInstant
    const accepted = yield* Ref.modify(context.state, (current) => {
      const entry = current.running.get(issueId)
      if (entry?.runId !== runId) {
        return [false, current]
      }
      if (phase === 'Agent' || phase === 'ConflictRepair') {
        return entry.phase._tag !== (phase === 'ConflictRepair' ? 'Postflight' : 'Preparing')
          ? [false, current]
          : [
              true,
              Transitions.updateRun(current, issueId, (run) => ({
                ...run,
                phase: { _tag: 'Agent', startedAt },
                lastEventAt: startedAt,
                turnActive: false,
              })),
            ]
      }
      return [
        true,
        Transitions.updateDetail(
          Transitions.notePostflightStarted(current, issueId, runId, startedAt),
          issueId,
          (record) => recordPostflightStarted(record, startedAt),
        ),
      ]
    })
    if (!accepted) {
      return yield* Effect.interrupt
    }
    yield* Ref.update(context.state, Transitions.publishDetails)
  })
