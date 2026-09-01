/**
 * The folds the orchestrator owns.
 *
 * A retry, a new attempt, a cancellation, and a handoff step are scheduling facts: no agent event
 * reports them, so the scheduler states them here. Each one closes or opens an attempt where that
 * is what happened, and every one of them appends a timeline entry, so the boundary between two
 * attempts is visible in the same log as the work either side of it.
 */

import { boundRedacted } from '../support/redaction.js'
import { endAttempt, nextSequence, noteError, push, setPhase } from './folding.js'
import type { AgentDetailRecord } from './record.js'
import { retainedAttemptLimit } from './snapshot.js'
import type { AgentHandoffDetail, HandoffStep, HandoffStepStatus } from './snapshot.js'

/**
 * Records a scheduled retry. The attempt boundary is explicit on the timeline, and the sequence
 * keeps rising, so ordering and session identity survive the boundary that separates the attempts.
 */
export const recordRetryScheduled = (
  record: AgentDetailRecord,
  at: Date,
  attemptNumber: number,
  dueAt: Date,
  reason: string | null,
): AgentDetailRecord => {
  const summary = reason === null ? null : boundRedacted(reason).text
  const ended = endAttempt(record, at, 'retrying', summary, true)
  const next = setPhase(ended, 'retrying', summary ?? 'Waiting to retry', at)
  const pushed = push(next, {
    sequence: nextSequence(next),
    attempt: next.attempt,
    at: at.toISOString(),
    event: 'retry/scheduled',
    operation: next.operation,
    truncated: false,
    category: 'retry',
    attemptNumber,
    dueAt: dueAt.toISOString(),
    reason: summary,
  })
  return summary === null ? pushed : noteError(pushed, at, 'error', 'retry', summary)
}

/** Opens a new attempt for the same issue, preserving the timeline that led to it. */
export const recordAttemptStarted = (
  record: AgentDetailRecord,
  at: Date,
  attemptNumber: number,
): AgentDetailRecord => {
  const attempts = [
    ...record.attempts,
    Object.freeze({
      attempt: attemptNumber,
      startedAt: at.toISOString(),
      endedAt: null,
      outcome: 'running' as const,
      reason: null,
      firstSequence: record.sequence + 1,
      lastSequence: record.sequence,
    }),
  ]
  // A new attempt is a new agent connection, so every session-scoped field is cleared rather than
  // left to describe the previous one: identity is only refilled by events the new session emits,
  // and the turn count starts over — it is folded forward with `Math.max`, so a session beginning
  // again at turn one could never displace a larger count carried over from the last. The session
  // this replaces is preserved in full by the retained session summaries.
  const started: AgentDetailRecord = {
    ...record,
    attempt: attemptNumber,
    retries: record.retries + 1,
    startedAt: at,
    lastActivityAt: null,
    threadId: null,
    turnId: null,
    sessionId: null,
    processId: null,
    turnCount: 0,
    attempts: Object.freeze(
      attempts.length > retainedAttemptLimit ? attempts.slice(-retainedAttemptLimit) : attempts,
    ),
  }
  const next = setPhase(started, 'starting', 'Starting the agent', at)
  return push(next, {
    sequence: nextSequence(next),
    attempt: attemptNumber,
    at: at.toISOString(),
    event: 'attempt/started',
    operation: next.operation,
    truncated: false,
    category: 'session',
    threadId: next.threadId,
    turnId: null,
    sessionId: next.sessionId,
    turnNumber: next.turnCount,
    processId: next.processId,
  })
}

/**
 * Records a cancellation. A queued retry that is dropped before it runs has already closed its
 * attempt as `retrying`, so that outcome is relabelled rather than left contradicting the
 * cancelled phase; a cancellation of a live attempt closes the still-open attempt as usual.
 */
export const recordCancellation = (
  record: AgentDetailRecord,
  at: Date,
  reason: string,
  relabelEndedAttempt = false,
): AgentDetailRecord => {
  const summary = boundRedacted(reason).text
  const ended = endAttempt(record, at, 'cancelled', summary, relabelEndedAttempt)
  const next = setPhase(ended, /stall/iu.test(reason) ? 'stalled' : 'cancelled', summary, at)
  return push(next, {
    sequence: nextSequence(next),
    attempt: next.attempt,
    at: at.toISOString(),
    event: 'agent/cancelled',
    operation: next.operation,
    truncated: false,
    category: 'cancellation',
    reason: summary,
  })
}

export type HandoffObservation = Readonly<{
  step: HandoffStep
  status: HandoffStepStatus
  message: string | null
  remoteBranch?: string | null
  pullRequest?: Readonly<{
    status: 'created' | 'reused' | 'absent'
    number: number | null
    url: string | null
    state: string | null
  }>
  outcome?: AgentHandoffDetail['outcome']
}>

/** The handoff outcomes that end an attempt rather than being followed by another one. */
const handedOffOutcomes: ReadonlySet<AgentHandoffDetail['outcome']> = new Set([
  'pull_request_open',
  'merged',
  'intervention_required',
])

export const recordHandoff = (
  record: AgentDetailRecord,
  at: Date,
  observation: HandoffObservation,
): AgentDetailRecord => {
  const summary = observation.message === null ? null : boundRedacted(observation.message).text
  const handoff: AgentHandoffDetail = Object.freeze({
    ...record.handoff,
    remoteBranch:
      observation.remoteBranch === undefined
        ? record.handoff.remoteBranch
        : Object.freeze({ status: observation.status, name: observation.remoteBranch }),
    pullRequest:
      observation.pullRequest === undefined
        ? record.handoff.pullRequest
        : Object.freeze({ ...observation.pullRequest }),
    outcome: observation.outcome ?? record.handoff.outcome,
    reason: summary,
  })
  // Only an outcome that actually ends the work closes the attempt. A missing branch or a failed
  // handoff is followed by another attempt, so closing it here would label a retrying attempt as
  // handed off — and the retry that follows could no longer correct it.
  const observed: AgentDetailRecord = { ...record, handoff }
  const ended =
    observation.outcome !== undefined && handedOffOutcomes.has(observation.outcome)
      ? endAttempt(observed, at, 'handed_off', summary)
      : observed
  const next = setPhase(ended, 'handing_off', summary ?? 'Handing off completed work', at)
  return push(next, {
    sequence: nextSequence(next),
    attempt: next.attempt,
    at: at.toISOString(),
    event: `handoff/${observation.step}`,
    operation: next.operation,
    truncated: false,
    category: 'handoff',
    step: observation.step,
    status: observation.status,
    message: summary,
  })
}
