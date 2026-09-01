/**
 * The folds every recorder shares.
 *
 * Each answers with a new record and leaves its argument untouched, so a recorder composes them —
 * note the error, set the phase, append the event — and the record the actor was holding is never
 * the one that changed. The bounded collections are enforced here, at the fold that grows them,
 * rather than at each caller.
 *
 * These are internal to the telemetry modules: `telemetry.ts` does not re-export them, because a
 * consumer folds an observation by naming what it observed, never by appending to the timeline
 * itself.
 */

import { withEntry } from '../support/collections.js'
import type { ErrorSeverity } from './events.js'
import type { AgentDetailRecord } from './record.js'
import type {
  AgentAttemptSummary,
  AgentPhase,
  AgentSessionSummary,
  AgentTimelineEvent,
} from './snapshot.js'
import {
  changedPathLimit,
  retainedAttemptLimit,
  retainedErrorLimit,
  timelineEventLimit,
} from './snapshot.js'

/**
 * Appends one timeline event, bounded by {@link timelineEventLimit}, and extends the current
 * attempt's sequence span to cover it.
 *
 * The event carries the sequence that {@link nextSequence} drew from this record, and every
 * recorder appends exactly one event, so adopting it here is what advances the record's counter.
 */
export const push = (record: AgentDetailRecord, event: AgentTimelineEvent): AgentDetailRecord => {
  const appended = [...record.events, Object.freeze(event)]
  const dropped = Math.max(appended.length - timelineEventLimit, 0)
  const attempt = record.attempts.at(-1)
  const attempts =
    attempt !== undefined && attempt.attempt === event.attempt
      ? Object.freeze([
          ...record.attempts.slice(0, -1),
          Object.freeze({
            ...attempt,
            firstSequence: attempt.lastSequence === 0 ? event.sequence : attempt.firstSequence,
            lastSequence: event.sequence,
          }),
        ])
      : record.attempts
  return {
    ...record,
    sequence: event.sequence,
    events: Object.freeze(dropped === 0 ? appended : appended.slice(-timelineEventLimit)),
    dropped: record.dropped + dropped,
    attempts,
  }
}

/** The sequence number the next appended event takes. */
export const nextSequence = (record: AgentDetailRecord): number => record.sequence + 1

export const setPhase = (
  record: AgentDetailRecord,
  phase: AgentPhase,
  operation: string | null,
  at: Date,
): AgentDetailRecord =>
  record.phase === phase
    ? { ...record, operation }
    : { ...record, phase, phaseSince: at, operation }

export const noteError = (
  record: AgentDetailRecord,
  at: Date,
  severity: ErrorSeverity,
  code: string | null,
  message: string,
): AgentDetailRecord => {
  const errors = [
    ...record.errors,
    Object.freeze({ at: at.toISOString(), attempt: record.attempt, severity, code, message }),
  ]
  return {
    ...record,
    errors: Object.freeze(
      errors.length > retainedErrorLimit ? errors.slice(-retainedErrorLimit) : errors,
    ),
  }
}

export const noteChangedPath = (
  record: AgentDetailRecord,
  path: string,
  addedLines: number | null,
  deletedLines: number | null,
  at: Date,
): AgentDetailRecord => {
  const existing = record.changedPaths.get(path)
  const truncated = existing === undefined && record.changedPaths.size >= changedPathLimit
  const changedPaths = truncated
    ? record.changedPaths
    : withEntry(
        record.changedPaths,
        path,
        Object.freeze({
          addedLines: (existing?.addedLines ?? 0) + (addedLines ?? 0),
          deletedLines: (existing?.deletedLines ?? 0) + (deletedLines ?? 0),
          lastActivityAt: at,
        }),
      )
  return {
    ...record,
    changedPaths,
    pathsTruncated: record.pathsTruncated || truncated,
    addedLines: record.addedLines + (addedLines ?? 0),
    deletedLines: record.deletedLines + (deletedLines ?? 0),
    lastFileActivityAt: at,
  }
}

/** Opens a session summary for the identity the agent has just reported. */
const openSession = (record: AgentDetailRecord, at: Date): AgentDetailRecord => {
  const sessions = [
    ...record.sessions,
    Object.freeze({
      attempt: record.attempt,
      threadId: record.threadId,
      sessionId: record.sessionId,
      processId: record.processId,
      startedAt: at.toISOString(),
      endedAt: null,
    }),
  ]
  return {
    ...record,
    sessions: Object.freeze(
      sessions.length > retainedAttemptLimit ? sessions.slice(-retainedAttemptLimit) : sessions,
    ),
  }
}

const replaceLastSession = (
  record: AgentDetailRecord,
  summary: AgentSessionSummary,
): AgentDetailRecord => ({
  ...record,
  sessions: Object.freeze([...record.sessions.slice(0, -1), Object.freeze(summary)]),
})

/** Ends the open session summary, if one is still open. Closing an ended session changes nothing. */
export const closeSession = (record: AgentDetailRecord, at: Date): AgentDetailRecord => {
  const open = record.sessions.at(-1)
  return open === undefined || open.endedAt !== null
    ? record
    : replaceLastSession(record, { ...open, endedAt: at.toISOString() })
}

/**
 * Keeps the retained session history on the same identity the record reports. A session is one turn
 * on a thread, so each turn is its own retained session, and the history is keyed on the composed
 * id rather than on whether a summary is still open: an event for the session the last summary
 * already names changes nothing, whether that summary is open or was ended by its turn.
 *
 * The first turn on a thread is the exception — it completes the summary `session_started` opened
 * while only the thread was known, because there was no session before that turn, only the thread
 * that would run it. Any other new identity ends whatever is still open and starts its own summary.
 */
export const alignSession = (record: AgentDetailRecord, at: Date): AgentDetailRecord => {
  if (record.threadId === null) {
    return record
  }
  const last = record.sessions.at(-1)
  if (last === undefined) {
    return openSession(record, at)
  }
  if (last.threadId === record.threadId && last.sessionId === record.sessionId) {
    return record
  }
  if (
    last.endedAt === null &&
    last.threadId === record.threadId &&
    last.sessionId === record.threadId
  ) {
    return replaceLastSession(record, {
      ...last,
      sessionId: record.sessionId,
      processId: record.processId,
    })
  }
  return openSession(closeSession(record, at), at)
}

/**
 * Closes the current attempt and, when a session is open, marks it ended.
 *
 * `relabel` re-states the outcome of an attempt that has already ended, keeping the moment it ended.
 * Scheduling a retry is the latest and most specific word on how an attempt turned out — later than
 * the cancellation or failed handoff that closed it moments earlier — so that path corrects the
 * label rather than leaving the attempt history claiming an ending that did not hold.
 */
export const endAttempt = (
  record: AgentDetailRecord,
  at: Date,
  outcome: AgentAttemptSummary['outcome'],
  reason: string | null,
  relabel = false,
): AgentDetailRecord => {
  const attempt = record.attempts.at(-1)
  const attempts =
    attempt !== undefined && (attempt.endedAt === null || relabel)
      ? Object.freeze([
          ...record.attempts.slice(0, -1),
          Object.freeze({
            ...attempt,
            endedAt: attempt.endedAt ?? at.toISOString(),
            outcome,
            reason,
          }),
        ])
      : record.attempts
  const session = record.sessions.at(-1)
  const sessions =
    session !== undefined && session.endedAt === null
      ? Object.freeze([
          ...record.sessions.slice(0, -1),
          Object.freeze({ ...session, endedAt: at.toISOString() }),
        ])
      : record.sessions
  return { ...record, attempts, sessions }
}
