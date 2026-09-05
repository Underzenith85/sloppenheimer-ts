import { Effect, Ref } from 'effect'

import { logWarning } from '../../support/logging.js'
import { asSettled } from '../../support/settled.js'
import { issueIsActive, logContext, stateIsIn } from '../policy.js'
import * as Transitions from '../transitions.js'
import { cancelRunning } from './runs.js'
import type { RuntimeCells } from './types.js'

/**
 * Brings live runs back into agreement with tracker eligibility. Agent silence is supervised
 * independently in the session scope, so slow tracker I/O cannot postpone its deadline.
 */
export const reconcile = (
  cells: RuntimeCells,
  retryDispatchAllowed: boolean,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    void retryDispatchAllowed
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
