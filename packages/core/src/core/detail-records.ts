import { Effect, Ref } from 'effect'

import type { Issue, IssueId } from '../domain/domain.js'
import { issueBranchName } from '../domain/handoff.js'
import { currentInstant } from '../support/clock.js'
import {
  createAgentDetailRecord,
  recordAttemptStarted,
  recordHandoff,
  recordIssueRefreshed,
  type AgentDetailRecord,
} from '../telemetry.js'
import { workspaceKey } from '../domain/workspace-containment.js'
import type { OrchestratorContext } from './runtime.js'
import type { HandoffEntry } from './state.js'
import * as Transitions from './transitions.js'

/**
 * The per-issue telemetry record and the published index built from it. Every write here is a
 * transition applied to the state cell: the record a reader sees is whichever value the last
 * transition produced, never one being mutated underneath it.
 */

/** Rebuilds the published detail index. Runs after every transition the event loop makes. */
export const publishDetails = (context: OrchestratorContext): Effect.Effect<void> =>
  Ref.update(context.state, Transitions.publishDetails)

/** Opens or reuses the detail record for an issue that is about to be dispatched. */
export const openDetailRecord = (
  context: OrchestratorContext,
  issue: Issue,
  attempt: number | null,
  dispatchLabels: readonly string[],
): Effect.Effect<AgentDetailRecord> =>
  Effect.gen(function* () {
    // Read before the transition, not inside it: a transition is a function of its inputs.
    const now = yield* currentInstant
    return yield* Ref.modify(context.state, (current) => {
      // A new session supersedes whatever aged out for this issue.
      const noted = Transitions.revivedDetail(Transitions.noteIssue(current, issue), issue.id)
      const existing = noted.details.get(issue.id)
      if (existing !== undefined) {
        // The same record carries every attempt for the issue, so ordering and session identity
        // survive the boundary that separates them.
        const started = recordAttemptStarted(
          recordIssueRefreshed(existing, issue),
          now,
          attempt ?? 0,
        )
        return [started, Transitions.putDetail(noted, issue.id, started)]
      }
      const record = createAgentDetailRecord({
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        attempt,
        startedAt: now,
        workspacePathKey: workspaceKey(issue.identifier),
        expectedBranch: issue.branchName ?? issueBranchName(issue),
        dispatchLabels,
      })
      return [record, Transitions.putDetail(noted, issue.id, record)]
    })
  })

/** Mirrors an observed pull-request disposition onto the issue's retained handoff detail. */
export const noteHandoffOutcome = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry,
  outcome: 'pull_request_open' | 'merged' | 'intervention_required',
): Effect.Effect<void> =>
  Ref.update(context.state, (current) =>
    Transitions.updateDetail(current, id, (record) =>
      recordHandoff(record, handoff.observedAt, {
        step: 'outcome',
        status: outcome === 'intervention_required' ? 'failed' : 'observed',
        message: handoff.reason,
        pullRequest: {
          status:
            record.handoff.pullRequest.status === 'pending'
              ? 'reused'
              : record.handoff.pullRequest.status,
          number: handoff.pullRequestNumber,
          url: handoff.pullRequestUrl,
          state: handoff.state,
        },
        outcome,
      }),
    ),
  )
