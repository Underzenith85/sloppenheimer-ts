/**
 * The Codex App Server wire shapes.
 *
 * Every notification and response Symphony reads is described here as a schema rather than poked at
 * field by field where it is used. Two properties of the protocol make that worth doing:
 *
 * - It reports the same value under two spellings — `rate_limits` on the `codex/event/*`
 *   notifications, `rateLimits` on the typed ones. {@link protocolStruct} normalizes casing once,
 *   so each field below is named a single time.
 * - It is not versioned against Symphony. A field in an unexpected shape must therefore degrade to
 *   absence rather than fail the turn that carried it, which is what {@link tolerant} states.
 *
 * The schemas decode *shape* only. Nothing here redacts or bounds: the raw text a notification
 * carries is handed back as it arrived and the caller redacts it before retaining it, so no
 * retained value is ever constructed ahead of the redactor.
 */

import { Schema } from 'effect'

import type { JsonObject, JsonValue } from '../../domain/domain.js'
import { isJsonObject, isJsonValue } from '../../support/json.js'
import { decodeOrNull, nonNegativeInteger, protocolStruct, tolerant } from '../../support/schema.js'
import type { TokenCounts } from '../../telemetry.js'

/**
 * A complete token reading. Every field is required: a partial reading would understate the total,
 * so a message missing one of them reports no usage at all rather than a wrong one.
 */
const tokenTotals = protocolStruct({
  inputTokens: nonNegativeInteger,
  outputTokens: nonNegativeInteger,
  totalTokens: nonNegativeInteger,
})

/**
 * A rate-limit report passes through unread. Its own keys name the windows, so normalizing them
 * would rename what an operator sees; only the values inside each window are ever decoded, in
 * `telemetry.ts`, where the report is finally read.
 */
const rateLimitReport = Schema.declare(isJsonObject)

const threadTokenUsageParams = protocolStruct({
  tokenUsage: tolerant(protocolStruct({ total: tolerant(tokenTotals) })),
})
const turnUsageParams = protocolStruct({ usage: tolerant(tokenTotals) })
const accountRateLimitsParams = protocolStruct({ rateLimits: tolerant(rateLimitReport) })

/** The body of a `codex/event/token_count`, whether or not it is wrapped in `msg`. */
const tokenCountBody = protocolStruct({
  info: tolerant(protocolStruct({ totalTokenUsage: tolerant(tokenTotals) })),
  rateLimits: tolerant(rateLimitReport),
})
const tokenCountParams = protocolStruct({ msg: tolerant(tokenCountBody) })

/**
 * The free text a notification carries, in the three places the protocol puts it. `Schema.String`
 * rather than a non-empty string: an empty message is a message the server chose to send.
 */
const messageParams = protocolStruct({
  message: tolerant(Schema.String),
  error: tolerant(protocolStruct({ message: tolerant(Schema.String) })),
  item: tolerant(protocolStruct({ type: tolerant(Schema.String), text: tolerant(Schema.String) })),
})

const identityParams = protocolStruct({
  threadId: tolerant(Schema.String),
  turnId: tolerant(Schema.String),
})

const turnParams = protocolStruct({
  turn: tolerant(protocolStruct({ id: tolerant(Schema.String), status: tolerant(Schema.String) })),
})

const responseIdentityResult = protocolStruct({
  thread: tolerant(protocolStruct({ id: tolerant(Schema.String) })),
  turn: tolerant(protocolStruct({ id: tolerant(Schema.String) })),
})

const hostToolCallParams = protocolStruct({
  tool: tolerant(Schema.String),
  arguments: Schema.optional(Schema.declare(isJsonValue)),
})

const protocolError = protocolStruct({ message: tolerant(Schema.String) })

const decodeThreadTokenUsage = decodeOrNull(threadTokenUsageParams)
const decodeTurnUsage = decodeOrNull(turnUsageParams)
const decodeAccountRateLimits = decodeOrNull(accountRateLimitsParams)
const decodeTokenCount = decodeOrNull(tokenCountParams)
const decodeTokenCountBody = decodeOrNull(tokenCountBody)
const decodeMessageParams = decodeOrNull(messageParams)
const decodeIdentityParams = decodeOrNull(identityParams)
const decodeTurnParams = decodeOrNull(turnParams)
const decodeResponseIdentity = decodeOrNull(responseIdentityResult)
const decodeHostToolCall = decodeOrNull(hostToolCallParams)
const decodeProtocolError = decodeOrNull(protocolError)

/** Thread and turn identity a message declares for itself. `null` means it declared none. */
export type ProtocolIdentity = Readonly<{ threadId: string | null; turnId: string | null }>

export type ProtocolTurn = Readonly<{ id: string; status: string | null }>

export type ProtocolTelemetry = Readonly<{
  usage: TokenCounts | null
  rateLimits: JsonObject | null
}>

/**
 * A host tool request as it arrived. Both fields are reported even when one is missing, because a
 * request that names a tool but no arguments is still reported against that tool.
 */
export type HostToolCall = Readonly<{ tool: string | null; arguments: JsonValue | undefined }>

/**
 * The token totals and rate-limit report a notification carries, by method. A method that reports
 * neither — the overwhelming majority — reports nothing here rather than being guessed at.
 */
export const telemetryFrom = (method: string, message: JsonObject): ProtocolTelemetry => {
  const params = message['params']
  switch (method) {
    case 'thread/tokenUsage/updated': {
      return {
        usage: decodeThreadTokenUsage(params)?.tokenUsage?.total ?? null,
        rateLimits: null,
      }
    }
    case 'turn/usage': {
      return { usage: decodeTurnUsage(params)?.usage ?? null, rateLimits: null }
    }
    case 'account/rateLimits/updated': {
      return { usage: null, rateLimits: decodeAccountRateLimits(params)?.rateLimits ?? null }
    }
    case 'codex/event/token_count': {
      // The `codex/event/*` family wraps its payload in `msg`; a build that sends it flat is read
      // the same way.
      const body = decodeTokenCount(params)?.msg ?? decodeTokenCountBody(params)
      return {
        usage: body?.info?.totalTokenUsage ?? null,
        rateLimits: body?.rateLimits ?? null,
      }
    }
    default: {
      return { usage: null, rateLimits: null }
    }
  }
}

/**
 * The free text a notification carries, exactly as the server sent it. The caller redacts and
 * bounds it before it is retained.
 */
export const messageTextFrom = (message: JsonObject): string | null => {
  const params = decodeMessageParams(message['params'])
  if (params === null) {
    return null
  }
  const item = params.item
  return (
    params.message ??
    params.error?.message ??
    (item?.type === 'agentMessage' ? item.text : null) ??
    null
  )
}

/**
 * Identity a notification carries itself. Item and delta notifications declare `threadId` and
 * `turnId` directly under `params`, so they attribute correctly even out of order; the turn
 * lifecycle notifications carry the turn nested under `params.turn` instead.
 */
export const notificationIdentity = (message: JsonObject): ProtocolIdentity =>
  decodeIdentityParams(message['params']) ?? { threadId: null, turnId: null }

/** The turn a lifecycle notification reports on, or `null` if it names none. */
export const turnFrom = (message: JsonObject): ProtocolTurn | null => {
  const turn = decodeTurnParams(message['params'])?.turn ?? null
  if (turn === null || turn.id === null) {
    return null
  }
  return { id: turn.id, status: turn.status }
}

/** Thread and turn identity a response result declares. `null` for either means it declared none. */
export const responseIdentity = (result: JsonValue): ProtocolIdentity => {
  const decoded = decodeResponseIdentity(result)
  return { threadId: decoded?.thread?.id ?? null, turnId: decoded?.turn?.id ?? null }
}

export const hostToolCallFrom = (message: JsonObject): HostToolCall => {
  const params = decodeHostToolCall(message['params'])
  return { tool: params?.tool ?? null, arguments: params?.arguments }
}

/** The message a JSON-RPC error carries, before redaction. */
export const protocolErrorMessage = (value: JsonValue): string =>
  decodeProtocolError(value)?.message ?? 'unknown protocol error'
