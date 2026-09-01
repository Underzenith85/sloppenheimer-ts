import { Option } from 'effect'

import type { IssueId } from '../../domain/domain.js'
import {
  capped,
  withEntry,
  withMember,
  withoutEntry,
  withoutMember,
} from '../../support/collections.js'
import { agentDetailPath, type AgentDetailRecord, type AgentDetailStatus } from '../../telemetry.js'
import {
  rememberedIdentifiers,
  retainedCompletedDetails,
  type PublishedDetail,
  type RuntimeState,
} from '../state.js'

/**
 * The actor-owned detail records and the index consumers read them through. Publication is what
 * applies the retention: a record whose session has ended joins the finished queue, and an evicted
 * issue keeps answering as completed rather than as one that never ran.
 */

export const putDetail = (
  state: RuntimeState,
  id: IssueId,
  record: AgentDetailRecord,
): RuntimeState => ({ ...state, details: withEntry(state.details, id, record) })

/** Rewrites one detail record through a reducer, when the issue still has one. */
export const updateDetail = (
  state: RuntimeState,
  id: IssueId,
  update: (record: AgentDetailRecord) => AgentDetailRecord,
): RuntimeState => {
  const record = state.details.get(id)
  if (record === undefined) {
    return state
  }
  return putDetail(state, id, update(record))
}

/**
 * Rebuilds the published detail index and applies the retention that goes with it: a record whose
 * session has ended joins the finished queue, the queue is trimmed to its cap, and every evicted
 * issue keeps answering as completed rather than as one that never ran.
 *
 * Called after every transition, so what a consumer reads always matches the scheduler it came
 * from. It is idempotent: publishing twice without an intervening change yields the same state.
 */
export const publishDetails = (state: RuntimeState): RuntimeState => {
  const published = new Map<string, PublishedDetail>()
  let finishedDetails = state.finishedDetails
  for (const [id, record] of state.details) {
    const running = state.running.get(id)
    const retry = state.retries.get(id)
    const status: AgentDetailStatus =
      running !== undefined ? 'running' : retry !== undefined ? 'retrying' : 'completed'
    if (status === 'completed') {
      if (!finishedDetails.includes(id)) {
        finishedDetails = [...finishedDetails, id]
      }
    } else {
      finishedDetails = finishedDetails.filter((finished) => finished !== id)
    }
    published.set(record.identifier, {
      _tag: 'Found',
      record,
      context: {
        self: agentDetailPath(record.identifier),
        status,
        stallTimeoutMs: running?.execution.stallTimeoutMs ?? 0,
        workerHost: 'local',
        // Read from the execution the agent is running under, falling back to the workflow in
        // force: composing no code-review services at all is what "handoff disabled" means.
        handoffEnabled: Option.isSome(
          running?.execution.codeReview ?? state.lastKnownGood.codeReview,
        ),
        branch: record.handoff.expectedBranch,
        retry:
          retry === undefined
            ? null
            : { attempt: retry.attempt, dueAt: new Date(retry.dueAt), reason: retry.error },
      },
    })
  }
  let details = state.details
  let agedOutDetails = state.agedOutDetails
  while (finishedDetails.length > retainedCompletedDetails) {
    const [evicted, ...remaining] = finishedDetails
    finishedDetails = remaining
    const record = evicted === undefined ? undefined : details.get(evicted)
    if (evicted === undefined || record === undefined) {
      continue
    }
    details = withoutEntry(details, evicted)
    agedOutDetails = capped(withMember(agedOutDetails, evicted), rememberedIdentifiers)
    published.set(record.identifier, { _tag: 'Completed' })
  }
  for (const [id, identifier] of state.identifiers) {
    if (published.has(identifier)) {
      continue
    }
    if (state.completed.has(id) || agedOutDetails.has(id)) {
      published.set(identifier, { _tag: 'Completed' })
      continue
    }
    published.set(
      identifier,
      state.claimed.has(id) && !state.running.has(id) && !state.handoffs.has(id)
        ? { _tag: 'Unavailable', reason: 'The agent session is still starting' }
        : { _tag: 'NoSession' },
    )
  }
  return { ...state, details, finishedDetails, agedOutDetails, publishedDetails: published }
}

/** A new session supersedes whatever aged out for this issue. */
export const revivedDetail = (state: RuntimeState, id: IssueId): RuntimeState => ({
  ...state,
  agedOutDetails: withoutMember(state.agedOutDetails, id),
})
