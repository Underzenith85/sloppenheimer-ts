import { Option } from 'effect'

import type { JsonObject } from '@sloppenheimer/core/domain/domain.js'
import type { TraceObservation } from '@sloppenheimer/core/domain/trace.js'
import type {
  AgentEvent,
  AgentEventPayload,
  AgentLifecycle,
  TokenCounts,
} from '@sloppenheimer/core/telemetry.js'
import type { ConnectionState } from './connection-state.js'
import { composeSessionId } from './session.js'

/** An event as its emitter states it, before the connection fills in what it knows. */
export type EventFields = Readonly<{
  event: string
  timestamp: Date
  processId: number | null
  message: string | null
  usage: TokenCounts | null
  rateLimits: JsonObject | null
  threadId: Option.Option<string>
  turnId: Option.Option<string>
  turnStatus: string | null
  lifecycle: AgentLifecycle | null
  payload: AgentEventPayload
  /** The high-fidelity reading of the same message, or `null` while capture is off. */
  trace: TraceObservation | null
}>

/**
 * Completes an event with the two fields derived from its identity rather than stated with it: the
 * composed session id, and the count of the turn it belongs to.
 *
 * Both are read from the state the emitter passes in, so an event that names a turn reports that
 * turn's count even when a later turn has since started.
 */
export const sessionEvent = (state: ConnectionState, fields: EventFields): AgentEvent => {
  const threadId = Option.getOrNull(fields.threadId)
  const turnId = Option.getOrNull(fields.turnId)
  return {
    event: fields.event,
    timestamp: fields.timestamp,
    processId: fields.processId,
    message: fields.message,
    usage: fields.usage,
    rateLimits: fields.rateLimits,
    threadId,
    turnId,
    sessionId: threadId === null ? null : composeSessionId(threadId, turnId),
    turnCount: Option.match(fields.turnId, {
      onNone: () => state.turnCount,
      onSome: (id) => state.turnCounts.get(id) ?? state.turnCount,
    }),
    turnStatus: fields.turnStatus,
    lifecycle: fields.lifecycle,
    payload: fields.payload,
    trace: fields.trace,
  }
}
