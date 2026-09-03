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
import type {
  AgentHandoffDetail,
  AgentPublicationDetail,
  HandoffStep,
  HandoffStepStatus,
} from './snapshot.js'

/**
 * The host has finished preparing the run and launched the agent.
 *
 * Until now the record's silence was the host's — a workspace being leased, a repository being
 * fetched, a hook running — and `buildAgentDetail` publishes no stall countdown for it. The
 * countdown starts here, for the reason `RunningEntry.agentStartedAt` gives, and the phase says
 * who is working now.
 */
export const recordAgentStarted = (record: AgentDetailRecord, at: Date): AgentDetailRecord =>
  record.agentStartedAt === null
    ? setPhase({ ...record, agentStartedAt: at }, 'starting', 'Starting the agent', at)
    : record

/**
 * The host's postflight has taken the run over from the agent.
 *
 * Phase rather than a publication: nothing is known yet about whether there is anything to publish
 * — the inspection has not run. What is known is who is working, and that is what the surfaces need
 * so a silent postflight does not read as a silent agent. `agentDetail` already exempts this phase
 * from the stall countdown, so saying it here is what stops the console reporting a stall for a
 * run whose stall detection is off.
 */
export const recordPostflightStarted = (record: AgentDetailRecord, at: Date): AgentDetailRecord =>
  record.phase === 'publishing'
    ? record
    : setPhase(record, 'publishing', 'The host is inspecting the workspace and publishing', at)

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
    agentStartedAt: null,
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
  const next = setPhase(started, 'starting', 'Preparing the workspace', at)
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

/**
 * One reading of what the host did with the workspace after a turn.
 *
 * It is recorded separately from the handoff steps that follow it because it is separately true: a
 * publication that failed leaves recoverable work whether or not a pull request is ever opened,
 * and an operator has to be able to see which of the two is blocking.
 */
export type PublicationObservation = Readonly<{
  status: AgentPublicationDetail['status']
  branch: string | null
  headSha?: string | null
  baselineSha?: string | null
  category?: string | null
  /** How many delivery attempts have failed for this work, when any have. */
  attempts?: number
  message: string | null
}>

/** The publication status as one of the handoff step statuses the timeline is written in. */
const publicationStepStatus = (status: AgentPublicationDetail['status']): HandoffStepStatus => {
  switch (status) {
    case 'not_performed': {
      return 'not_performed'
    }
    case 'pending': {
      return 'pending'
    }
    case 'published': {
      return 'observed'
    }
    case 'no_changes': {
      return 'absent'
    }
    case 'failed': {
      return 'failed'
    }
  }
}

/**
 * Records the postflight. `pending` moves the phase to `publishing`, so an operator watching a
 * finished turn sees the host working rather than an agent that has gone quiet; every other status
 * leaves the phase alone, because what happens next — a handoff, a retry, a wait — is what should
 * name it.
 */
export const recordPublication = (
  record: AgentDetailRecord,
  at: Date,
  observation: PublicationObservation,
): AgentDetailRecord => {
  const summary = observation.message === null ? null : boundRedacted(observation.message).text
  const publication: AgentPublicationDetail = Object.freeze({
    status: observation.status,
    branch: observation.branch,
    headSha: observation.headSha ?? null,
    baselineSha: observation.baselineSha ?? null,
    category: observation.category ?? null,
    attempts: observation.attempts ?? record.handoff.publication.attempts,
    reason: summary,
  })
  // The postflight is the newest thing known about this work, so it names the outcome: a failed
  // delivery is what the issue is waiting on, and a clean worktree is the whole of what the turn
  // achieved. A handoff step recorded afterwards supersedes it, which is correct — by then
  // something later is true.
  const outcome =
    observation.status === 'failed'
      ? ('delivery_failed' as const)
      : observation.status === 'no_changes'
        ? ('no_progress' as const)
        : record.handoff.outcome
  const observed: AgentDetailRecord = {
    ...record,
    handoff: Object.freeze({ ...record.handoff, publication, outcome }),
  }
  const next =
    observation.status === 'pending'
      ? setPhase(observed, 'publishing', summary ?? 'Publishing the agent changes', at)
      : observed
  const pushed = push(next, {
    sequence: nextSequence(next),
    attempt: next.attempt,
    at: at.toISOString(),
    event: 'handoff/publication',
    operation: next.operation,
    truncated: false,
    category: 'handoff',
    step: 'publication',
    status: publicationStepStatus(observation.status),
    message: summary,
  })
  return observation.status === 'failed' && summary !== null
    ? noteError(pushed, at, 'error', observation.category ?? 'publication', summary)
    : pushed
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
