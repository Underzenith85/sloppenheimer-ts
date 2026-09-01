/**
 * The fold that turns one normalized agent event into the record.
 *
 * The entry point does the part every event shares — carrying identity, usage, and rate limits
 * forward, keeping the retained session history aligned with the turn the record is on, and drawing
 * the sequence the appended entry takes — and then hands the event to the branch its payload names.
 * Each branch is a function of the record that preamble produced: it sets the phase its category
 * implies and appends exactly one timeline entry, so the phase the entry reports as `operation` is
 * the one that branch just set.
 */

import { bound } from '../support/redaction.js'
import { decodeRateLimits, foldTurnIdentity } from './events.js'
import type { AgentEvent, AgentEventPayload, FileChange } from './events.js'
import {
  alignSession,
  closeSession,
  nextSequence,
  noteChangedPath,
  noteError,
  push,
  setPhase,
} from './folding.js'
import type { AgentDetailRecord } from './record.js'
import { changedPathLimit } from './snapshot.js'
import type { AgentTimelineBase } from './snapshot.js'

/**
 * Whether an event reports the end of the turn it names. A session is one turn, so its retained
 * summary ends here rather than whenever the next turn happens to start or the attempt is torn
 * down — the gap where a continuation decides whether to run again belongs to no session.
 */
const endsTurn = (event: AgentEvent): boolean => event.lifecycle?.phase === 'turn_settled'

const messageOperation = (text: string | null): string =>
  text === null || text.length === 0 ? 'Writing a reply' : `Replying: ${bound(text, 80).text}`

/**
 * The timeline fields the preamble fills in before the payload has been read. `operation` is not
 * among them: it is taken from the record the branch answers with, which is the record whose phase
 * that branch may just have moved.
 */
type EventBase = Omit<AgentTimelineBase, 'operation'>

type PayloadOf<Kind extends AgentEventPayload['kind']> = Extract<AgentEventPayload, { kind: Kind }>

/**
 * Tokens and rate limits are reported alongside whatever else an event carried, and the reading is
 * the same whichever payload that was, so it is retained as usage rather than by category.
 */
const appendUsage = (
  record: AgentDetailRecord,
  base: EventBase,
  event: AgentEvent,
): AgentDetailRecord =>
  push(record, {
    ...base,
    operation: record.operation,
    category: 'usage',
    tokens: event.usage === null ? null : record.tokens,
    rateLimits: record.rateLimits,
  })

const appendSession = (
  record: AgentDetailRecord,
  base: EventBase,
  event: AgentEvent,
): AgentDetailRecord => {
  const next =
    record.phase === 'starting'
      ? setPhase(record, 'awaiting_model', 'Waiting for the model', event.timestamp)
      : record
  return push(next, {
    ...base,
    operation: next.operation,
    category: 'session',
    // The timeline is a log of what arrived, so an entry names the turn its own event belongs
    // to. Only the record's current identity is folded forward: a superseded turn reporting
    // late is still recorded here against the turn that produced it, rather than being
    // relabelled as the turn running now. An event that carries no identity of its own — the
    // client's own session-level notices — takes the record's.
    threadId: event.threadId ?? next.threadId,
    turnId: event.turnId ?? next.turnId,
    sessionId: event.sessionId ?? next.sessionId,
    turnNumber: event.turnId === null ? next.turnCount : event.turnCount,
    processId: next.processId,
  })
}

const appendReasoning = (
  record: AgentDetailRecord,
  base: EventBase,
  at: Date,
): AgentDetailRecord => {
  const next = setPhase(record, 'reasoning', 'Thinking', at)
  return push(next, { ...base, operation: next.operation, category: 'reasoning' })
}

const appendMessage = (
  record: AgentDetailRecord,
  base: EventBase,
  payload: PayloadOf<'message'>,
  at: Date,
): AgentDetailRecord => {
  const next = setPhase(record, 'responding', messageOperation(payload.text), at)
  return push(next, {
    ...base,
    truncated: payload.truncated,
    operation: next.operation,
    category: 'message',
    role: payload.role,
    text: payload.text,
  })
}

const appendTool = (
  record: AgentDetailRecord,
  base: EventBase,
  payload: PayloadOf<'tool'>,
  at: Date,
): AgentDetailRecord => {
  // A finished tool call is not a running one. Leaving the phase at `running_tool` would keep
  // the inspector reporting "Calling …" for work that already returned, and eventually report
  // that finished call as stalled while the model is simply deciding what to do next.
  const next =
    payload.state === 'completed'
      ? setPhase(record, 'awaiting_model', `Finished ${payload.name}`, at)
      : payload.state === 'failed'
        ? setPhase(record, 'awaiting_model', `${payload.name} failed`, at)
        : setPhase(record, 'running_tool', `Calling ${payload.name}`, at)
  return push(next, {
    ...base,
    operation: next.operation,
    category: 'tool',
    name: payload.name,
    state: payload.state,
    inputBytes: payload.inputBytes,
    outputBytes: payload.outputBytes,
  })
}

const appendCommand = (
  record: AgentDetailRecord,
  base: EventBase,
  payload: PayloadOf<'command'>,
  at: Date,
): AgentDetailRecord => {
  const quality =
    payload.quality === null
      ? record
      : { ...record, qualityPhase: payload.quality, qualityCommandState: payload.state }
  const exit = payload.exitCode === null ? '' : ` (exit ${String(payload.exitCode)})`
  const next =
    payload.state === 'completed'
      ? setPhase(quality, 'awaiting_model', `Finished ${payload.program}${exit}`, at)
      : payload.state === 'failed'
        ? setPhase(quality, 'awaiting_model', `${payload.program} failed${exit}`, at)
        : setPhase(quality, 'running_command', `Running ${payload.program}`, at)
  return push(next, {
    ...base,
    operation: next.operation,
    category: 'command',
    program: payload.program,
    argumentCount: payload.argumentCount,
    quality: payload.quality,
    state: payload.state,
    exitCode: payload.exitCode,
    durationMs: payload.durationMs,
  })
}

/** What the inspector reports the agent is doing, for a patch that may touch more than one file. */
const editingOperation = (files: readonly FileChange[]): string => {
  const first = files[0]
  if (first === undefined) {
    return 'Editing the workspace'
  }
  return files.length === 1
    ? `Editing ${first.path}`
    : `Editing ${first.path} and ${String(files.length - 1)} more`
}

/**
 * What a patch did in total. A sum of nothing reported is `null` rather than zero: a patch whose
 * every change carried no diff to count has an unknown size, not a size of none.
 */
const patchLines = (
  files: readonly FileChange[],
  read: (file: FileChange) => number | null,
): number | null =>
  files.reduce<number | null>(
    (carried, file) => (read(file) === null ? carried : (carried ?? 0) + (read(file) ?? 0)),
    null,
  )

const appendFile = (
  record: AgentDetailRecord,
  base: EventBase,
  payload: PayloadOf<'file'>,
  at: Date,
): AgentDetailRecord => {
  // A runner reports one file item twice — the patch it proposes, then the patch it applied — so
  // only the terminal report reaches the ledger: counting the proposal as well would double every
  // line count, and counting a failed or declined patch would report an edit the worktree never
  // received. The event itself is retained either way, so the timeline still shows the attempt.
  const changed =
    payload.state === 'completed'
      ? payload.files.reduce(
          (carried, file) =>
            noteChangedPath(carried, file.path, file.addedLines, file.deletedLines, at),
          record,
        )
      : record
  const next = setPhase(changed, 'editing', editingOperation(payload.files), at)
  // Every file counts toward the totals above; the entry names as many as the record retains paths
  // for, and carries the count of the rest so nothing reads as though the patch were that small.
  return push(next, {
    ...base,
    operation: next.operation,
    category: 'file',
    state: payload.state,
    files: Object.freeze(payload.files.slice(0, changedPathLimit)),
    fileCount: payload.files.length,
    addedLines: patchLines(payload.files, (file) => file.addedLines),
    deletedLines: patchLines(payload.files, (file) => file.deletedLines),
  })
}

const appendError = (
  record: AgentDetailRecord,
  base: EventBase,
  payload: PayloadOf<'error'>,
  at: Date,
): AgentDetailRecord => {
  const next = noteError(record, at, payload.severity, payload.code, payload.message)
  return push(next, {
    ...base,
    truncated: payload.truncated,
    operation: next.operation,
    category: 'error',
    severity: payload.severity,
    code: payload.code,
    message: payload.message,
  })
}

const appendCancellation = (
  record: AgentDetailRecord,
  base: EventBase,
  payload: PayloadOf<'cancellation'>,
  at: Date,
): AgentDetailRecord => {
  const next = setPhase(record, 'cancelled', payload.reason, at)
  return push(next, {
    ...base,
    operation: next.operation,
    category: 'cancellation',
    reason: payload.reason,
  })
}

/** An unrecognized message is still evidence of life, so it is retained by method name only. */
const appendUnrecognized = (record: AgentDetailRecord, base: EventBase): AgentDetailRecord =>
  push(record, {
    ...base,
    operation: record.operation,
    category: 'session',
    threadId: record.threadId,
    turnId: record.turnId,
    sessionId: record.sessionId,
    turnNumber: record.turnCount,
    processId: record.processId,
  })

/**
 * Folds one normalized agent event into the record and returns the result. Every retained string
 * arrived already redacted and bounded from the parser; nothing here widens it.
 */
export const recordAgentEvent = (
  record: AgentDetailRecord,
  event: AgentEvent,
): AgentDetailRecord => {
  const at = event.timestamp
  // Turn count, token totals, and rate limits are already normalized by the client; this layer
  // consumes them rather than deriving its own. The same token counts reach the record and the
  // usage timeline event, and a timeline event is only frozen shallowly, so the object they share
  // is frozen here rather than left reachable through `events[i].tokens`.
  const reported: AgentDetailRecord = {
    ...record,
    lastActivityAt: at,
    processId: event.processId ?? record.processId,
    threadId: event.threadId ?? record.threadId,
    ...foldTurnIdentity(record, event),
    tokens: event.usage === null ? record.tokens : Object.freeze({ ...event.usage }),
    rateLimits: event.rateLimits === null ? record.rateLimits : decodeRateLimits(event.rateLimits),
  }
  // Every event, not only a session-scoped one: whichever event first reports a turn's identity
  // is the one the retained history has to follow, or the summaries drift from `identity`.
  const aligned = alignSession(reported, at)
  // Only the turn the record is actually on: a superseded turn reporting its end late names a
  // session that already closed, and must not end the one running now.
  const observed =
    endsTurn(event) && event.turnId !== null && event.turnId === aligned.turnId
      ? closeSession(aligned, at)
      : aligned
  const base: EventBase = {
    sequence: nextSequence(observed),
    attempt: observed.attempt,
    at: at.toISOString(),
    event: event.event,
    truncated: false,
  }
  if (event.usage !== null || event.rateLimits !== null) {
    return appendUsage(observed, base, event)
  }
  const payload = event.payload
  switch (payload.kind) {
    case 'session':
      return appendSession(observed, base, event)
    case 'reasoning':
      return appendReasoning(observed, base, at)
    case 'message':
      return appendMessage(observed, base, payload, at)
    case 'tool':
      return appendTool(observed, base, payload, at)
    case 'command':
      return appendCommand(observed, base, payload, at)
    case 'file':
      return appendFile(observed, base, payload, at)
    case 'error':
      return appendError(observed, base, payload, at)
    case 'cancellation':
      return appendCancellation(observed, base, payload, at)
    case 'none':
      return appendUnrecognized(observed, base)
  }
}
