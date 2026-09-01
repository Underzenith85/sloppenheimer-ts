/**
 * The vocabulary a runner's adapter produces.
 *
 * Everything here describes one protocol message as the adapter normalized it: bounded, already
 * redacted, and carrying its own reading of what the message means for the session's lifecycle.
 * Nothing in this module knows about the record those messages are folded into, which is what lets
 * an adapter package depend on it without depending on the orchestrator's read model.
 */

import type { JsonObject, JsonValue } from '../domain/domain.js'
import {
  decodeOrNull,
  finiteNumber,
  protocolRecord,
  protocolStruct,
  tolerant,
} from '../support/schema.js'
import { bound, redact } from '../support/redaction.js'

export type TokenCounts = Readonly<{
  inputTokens: number
  outputTokens: number
  totalTokens: number
}>

export type RateLimitWindow = Readonly<{
  name: string
  usedPercent: number | null
  windowMinutes: number | null
  resetsInSeconds: number | null
}>

export type ToolState = 'started' | 'completed' | 'failed' | 'approved' | 'withheld'
export type FileChangeKind = 'add' | 'update' | 'delete' | 'unknown'
export type MessageRole = 'assistant' | 'user'
export type ErrorSeverity = 'warning' | 'error'

/** The quality command an agent is running, recognized from an allowlist of subcommand words. */
export type QualityPhase = 'format' | 'lint' | 'typecheck' | 'test' | 'build' | 'check'

const qualityPhases: readonly QualityPhase[] = [
  'format',
  'lint',
  'typecheck',
  'test',
  'build',
  'check',
]

/**
 * The normalized, bounded form of one protocol message. Everything unbounded in the original —
 * tool input and output, file contents, command arguments, reasoning text — is reduced to counts
 * and allowlisted labels here, at the parser, so no consumer ever holds the original.
 */
export type AgentEventPayload =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'session' }>
  | Readonly<{ kind: 'reasoning' }>
  | Readonly<{ kind: 'message'; role: MessageRole; text: string | null; truncated: boolean }>
  | Readonly<{
      kind: 'tool'
      name: string
      state: ToolState
      inputBytes: number | null
      outputBytes: number | null
    }>
  | Readonly<{
      kind: 'command'
      program: string
      argumentCount: number
      quality: QualityPhase | null
      state: ToolState
      exitCode: number | null
      durationMs: number | null
    }>
  | Readonly<{
      kind: 'file'
      path: string
      change: FileChangeKind
      addedLines: number | null
      deletedLines: number | null
    }>
  | Readonly<{
      kind: 'error'
      severity: ErrorSeverity
      code: string | null
      message: string
      truncated: boolean
    }>
  | Readonly<{ kind: 'cancellation'; reason: string }>

export type AgentTurnOutcome = 'completed' | 'cancelled' | 'failed'

/**
 * What one event means for the session's lifecycle, as the runner that emitted it reads its own
 * vocabulary.
 *
 * The orchestrator used to recognize the lifecycle by matching one backend's literal method names,
 * which meant a runner with a different vocabulary would run to completion while the scheduler
 * observed nothing at all. Stating the meaning on the event removes that failure mode entirely: an adapter
 * cannot forget to be understood, and no consumer can consult the wrong runner's reading. `null` is
 * the ordinary case — most messages report progress rather than a lifecycle transition.
 */
export type AgentLifecycle =
  | Readonly<{ phase: 'session_started' }>
  | Readonly<{ phase: 'turn_started' }>
  | Readonly<{ phase: 'turn_settled'; outcome: AgentTurnOutcome }>

/**
 * The canonical session event. Identity, token totals, rate limits, turn count, and turn status are
 * the normalized telemetry the runner's adapter produces; `payload` is that adapter's bounded,
 * pre-redacted view of the same message, for the retained timeline.
 */
export type AgentEvent = Readonly<{
  event: string
  timestamp: Date
  processId: number | null
  message: string | null
  usage: TokenCounts | null
  rateLimits: JsonObject | null
  threadId: string | null
  turnId: string | null
  sessionId: string | null
  turnCount: number
  turnStatus: string | null
  payload: AgentEventPayload
  /** What this event means for the session, or `null` when it reports no transition. */
  lifecycle: AgentLifecycle | null
}>

/**
 * One rate-limit window, as a runner reports it. Every field is tolerant and the record is
 * normalized to one casing by {@link protocolStruct}, so a backend reporting `used_percent` on one
 * message and `usedPercent` on the next is answered here rather than at each field read.
 *
 * This decodes the window's *shape* only. Redaction and bounding happen in {@link decodeRateLimits}
 * below, so no retained value is ever constructed before the redactor has seen it.
 */
const rateLimitWindowSource = protocolStruct({
  usedPercent: tolerant(finiteNumber),
  windowMinutes: tolerant(finiteNumber),
  resetsInSeconds: tolerant(finiteNumber),
})

const decodeRateLimitWindow = decodeOrNull(rateLimitWindowSource)
const decodeRateLimitReport = decodeOrNull(protocolRecord)

export const qualityPhaseOf = (command: string): QualityPhase | null => {
  const words = new Set(command.toLowerCase().split(/[^a-z]+/u))
  // `check` last: a composite quality command usually names the specific step as well, and the
  // specific step is the more useful label.
  return (
    qualityPhases.find((phase) => phase !== 'check' && words.has(phase)) ??
    (words.has('check') ? 'check' : null)
  )
}

export const decodeRateLimits = (value: JsonValue | undefined): readonly RateLimitWindow[] => {
  const report = decodeRateLimitReport(value)
  if (report === null) {
    return []
  }
  const windows: RateLimitWindow[] = []
  // The report's own keys name the windows, so they are not casing-normalized: a window is
  // whatever the server called it.
  for (const [name, window] of Object.entries(report)) {
    const decoded = decodeRateLimitWindow(window)
    if (decoded === null) {
      continue
    }
    windows.push({ name: bound(redact(name), 40).text, ...decoded })
  }
  // Frozen on construction, so the copies a timeline event and a published snapshot each hold
  // cannot be edited into the actor's own reading.
  return Object.freeze(
    windows
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((window) => Object.freeze(window)),
  )
}

/** The turn half of a session identity, held by both the runtime snapshot and the agent detail. */
export type TurnIdentity = Readonly<{
  turnId: string | null
  sessionId: string | null
  turnCount: number
}>

/**
 * The turn identity a holder should carry after one event. A session id names a turn, so both
 * halves move together: an event from a turn the run has already moved past restores neither, and
 * the runtime snapshot and the agent detail can never disagree about which turn is current. The one
 * event carrying no turn at all is `session_started`, and it precedes every turn on the thread.
 *
 * Both holders reset the count when a new attempt opens its own connection, so a fresh session
 * starting again at turn one is never held back by the count the previous one reached.
 */
export const foldTurnIdentity = (held: TurnIdentity, event: AgentEvent): TurnIdentity => {
  const supersedes = event.turnId !== null && event.turnCount >= held.turnCount
  return {
    turnId: supersedes ? event.turnId : held.turnId,
    sessionId:
      supersedes || event.turnId === null ? (event.sessionId ?? held.sessionId) : held.sessionId,
    turnCount: Math.max(held.turnCount, event.turnCount),
  }
}
