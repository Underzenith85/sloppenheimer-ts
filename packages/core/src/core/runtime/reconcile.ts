import { Clock, Effect, Option, Ref, type Scope } from 'effect'

import { logWarning } from '../../support/logging.js'
import { asSettled } from '../../support/settled.js'
import { issueIsActive, logContext, stateIsIn } from '../policy.js'
import * as Transitions from '../transitions.js'
import { cancelRunning } from './runs.js'
import { scheduleRetry } from './scheduling.js'
import type { RuntimeCells } from './types.js'

/**
 * Brings the live runs back into agreement with the tracker: a run that has stopped reporting
 * protocol activity is stalled and retried, and a run whose issue no longer qualifies is cancelled.
 */
export const reconcile = (
  cells: RuntimeCells,
  retryDispatchAllowed: boolean,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (retryDispatchAllowed) {
      yield* retireStalledRuns(cells)
    }
    const refreshing = yield* Ref.get(cells.state)
    if (refreshing.running.size === 0) {
      return
    }
    for (const [id, entry] of refreshing.running) {
      const execution = entry.execution
      const refreshResult = yield* execution.tracker.fetchIssuesByIds([id]).pipe(asSettled)
      if (refreshResult._tag === 'Failed') {
        yield* logWarning('reconciliation failed; keeping worker running', {
          ...logContext(entry.issue),
          action: 'reconciliation',
          outcome: 'failed',
          error: refreshResult.error.message,
        })
        continue
      }
      const issue = refreshResult.value.find((candidate) => candidate.id === id)
      if (issue === undefined) {
        // The handoff outlives the issue the tracker stopped reporting, so a head this worker
        // pushed is still the repair's to account for on the next inspection.
        yield* cancelRunning(cells, id, false, 'the tracker no longer reports the issue', 'settle')
        continue
      }
      const terminal = stateIsIn(issue.state, execution.terminalStates)
      if (terminal || !issueIsActive(issue, execution)) {
        yield* cancelRunning(
          cells,
          id,
          terminal,
          terminal
            ? `the issue reached the terminal state ${issue.state}`
            : `the issue left its active states as ${issue.state}`,
          // A worker may have pushed immediately before its issue stopped qualifying, and nothing
          // continues it: keep the baseline for one inspection so that head is attributed. A
          // terminal issue keeps its baseline untouched, so the next inspection still reaches the
          // verdict for a repair that changed nothing.
          terminal ? 'retain' : 'settle',
        )
      } else {
        yield* Ref.update(cells.state, (current) =>
          Transitions.updateRun(current, id, (live) => ({ ...live, issue })),
        )
      }
    }
  })

/** Cancels every run that has gone quiet past its stall timeout, and queues its continuation. */
const retireStalledRuns = (cells: RuntimeCells): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const stalling = yield* Ref.get(cells.state)
    if (stalling.running.size === 0) {
      return
    }
    const now = yield* Clock.currentTimeMillis
    for (const [id, entry] of stalling.running) {
      const stallTimeout = entry.execution.stallTimeoutMs
      const activeAt = entry.lastEventAt?.getTime() ?? entry.startedAt.getTime()
      // A postflight is silent on the agent protocol by construction, because no agent is running.
      // Retiring one as a stalled agent would turn a slow inspection or push into another coding
      // turn — a publication problem read as an agent failure, which is what the postflight exists
      // to stop. A publication that cannot finish is the source control's to fail, and it fails as
      // a delivery.
      if (entry.postflightStartedAt !== null) {
        continue
      }
      if (stallTimeout <= 0 || now - activeAt <= stallTimeout) {
        continue
      }
      const ended = yield* cancelRunning(
        cells,
        id,
        false,
        `the agent stalled after ${String(stallTimeout)}ms without protocol activity`,
        // The retry scheduled just below continues this repair from the same baseline.
        'retain',
      )
      if (Option.isSome(ended)) {
        yield* scheduleRetry(
          cells,
          ended.value.issue,
          (ended.value.attempt ?? 0) + 1,
          'agent stalled',
          false,
          ended.value.repairRun,
        )
      }
    }
  })
