import { Deferred, Effect, Option, Queue, Ref } from 'effect'

import { identifierIssueNumber, issuesForNumber } from '../policy.js'
import * as Transitions from '../transitions.js'
import { releaseIssueFiberFork } from './execution.js'
import type { RuntimeCells } from './types.js'

/** Control acknowledges committed intent and signals execution without waiting for tracker I/O. */
export const changeIssueIntent = (
  cells: RuntimeCells,
  issueNumber: number,
  paused: boolean,
): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      if (cells.durable !== undefined) {
        for (const record of yield* cells.durable.snapshot) {
          if (Option.contains(identifierIssueNumber(record.identifier), issueNumber)) {
            yield* cells.durable.setIntent(record.identifier, paused ? 'paused' : 'active')
          }
        }
      }
      const affected = yield* Ref.modify(cells.state, (current) => {
        const runs = issuesForNumber(current.running, issueNumber).flatMap((id) => {
          const run = current.running.get(id)
          return run === undefined ? [] : [{ issueId: id, runId: run.runId }]
        })
        return [
          runs,
          paused
            ? Transitions.pauseIssueNumber(current, issueNumber)
            : Transitions.resumeIssueNumber(current, issueNumber),
        ]
      })
      if (paused) {
        for (const run of affected) {
          yield* releaseIssueFiberFork(cells.execution, 'worker', run.issueId)
        }
      }
      const reply = yield* Deferred.make<void>()
      yield* Queue.offer(cells.mailbox, {
        _tag: 'SetIssuePaused',
        issueNumber,
        paused,
        reply,
        committed: true,
        affectedRuns: affected,
      })
    }),
  )
