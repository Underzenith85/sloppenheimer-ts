/**
 * The Codex App Server's own reading of its protocol messages, as the bounded payload the timeline
 * retains.
 *
 * This lived in `@sloppenheimer/core`'s telemetry module while Codex was the only runner. It decodes one
 * backend's wire shapes — its item union, its notification envelope, its client-emitted event names
 * — so it belongs with that backend: a second runner normalizes its own messages and would be
 * actively misread by these schemas rather than merely unserved by them. What stays in core is the
 * vocabulary both ends share: `AgentEventPayload`, `AgentEvent`, and `qualityPhaseOf`.
 *
 * The schemas decode the *protocol* shape only. Every field is tolerant and every record is
 * normalized to one casing by `protocolStruct`, so the App Server's habit of reporting the same
 * value as `used_percent` on one notification and `usedPercent` on the next is answered here rather
 * than at each field read. Redaction and bounding stay in the payload builders, so no retained
 * value is ever constructed before the redactor has seen it.
 */

import { Schema } from 'effect'

import type { JsonValue } from '@sloppenheimer/core/domain/domain.js'
import {
  decodeOrNull,
  finiteNumber,
  nonEmptyString,
  protocolStruct,
  tolerant,
} from '@sloppenheimer/core/support/schema.js'
import {
  bound,
  boundRedacted,
  commandSummary,
  redact,
  type Redactor,
} from '@sloppenheimer/core/support/redaction.js'
import {
  qualityPhaseOf,
  type AgentEventPayload,
  type ToolState,
} from '@sloppenheimer/core/telemetry.js'

import { fileChangesOf } from './file-changes.js'

const noPayload: AgentEventPayload = Object.freeze({ kind: 'none' })

/** A command is reported either as one line or as its already-split words. */
const commandSource = Schema.Union(
  nonEmptyString,
  Schema.transform(Schema.Array(Schema.Unknown), Schema.String, {
    strict: false,
    decode: (parts: readonly unknown[]) =>
      parts.filter((part) => typeof part === 'string').join(' '),
    encode: (text: string) => [text],
  }).pipe(Schema.filter((text) => text.length > 0)),
)

/**
 * One protocol item, in the union of every shape the App Server reports. The type word decides
 * which fields the payload below reads; the rest are simply absent.
 *
 * `input`, `arguments`, `args`, `output`, and `result` are deliberately left unread: only their
 * serialized size is retained, so the values reach {@link byteLength} as they arrived.
 */
const itemSource = protocolStruct({
  type: tolerant(nonEmptyString),
  itemType: tolerant(nonEmptyString),
  status: tolerant(nonEmptyString),
  state: tolerant(nonEmptyString),
  text: tolerant(nonEmptyString),
  content: tolerant(nonEmptyString),
  message: tolerant(nonEmptyString),
  error: tolerant(nonEmptyString),
  code: tolerant(nonEmptyString),
  name: tolerant(nonEmptyString),
  tool: tolerant(nonEmptyString),
  server: tolerant(nonEmptyString),
  command: tolerant(commandSource),
  commandLine: tolerant(commandSource),
  exitCode: tolerant(finiteNumber),
  durationMs: tolerant(finiteNumber),
  changes: Schema.optional(Schema.Unknown),
  input: Schema.optional(Schema.Unknown),
  arguments: Schema.optional(Schema.Unknown),
  args: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
})

/** A notification's parameters, as far as the retained payload is concerned. */
const notificationSource = protocolStruct({
  item: Schema.optional(Schema.Unknown),
  text: tolerant(nonEmptyString),
  message: tolerant(nonEmptyString),
})

const decodeItem = decodeOrNull(itemSource)
const decodeNotification = decodeOrNull(notificationSource)

/** The size of a payload we deliberately do not retain, so an operator still sees its scale. */
const byteLength = (value: unknown): number | null => {
  if (value === undefined) {
    return null
  }
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return null
  }
}

const itemState = (method: string, status: string | null): ToolState => {
  const reported = status?.toLowerCase() ?? null
  // `declined` is terminal and is not success: the patch or command it names never ran, so an item
  // reporting it must not be left looking like one still in progress.
  if (reported === 'failed' || reported === 'error' || reported === 'declined') {
    return 'failed'
  }
  if (reported === 'completed' || reported === 'succeeded' || method.endsWith('/completed')) {
    return 'completed'
  }
  return 'started'
}

const itemPayload = (
  method: string,
  source: unknown,
  redactor: Redactor,
): AgentEventPayload | null => {
  const item = decodeItem(source)
  if (item === null) {
    return null
  }
  const type = (item.type ?? item.itemType ?? '').toLowerCase()
  const status = item.status ?? item.state
  if (type.includes('reasoning')) {
    // Private reasoning is never retained, not even truncated: the fact that the agent is thinking
    // is the whole of the signal an operator is entitled to.
    return { kind: 'reasoning' }
  }
  if (type.includes('message')) {
    const raw = item.text ?? item.content ?? item.message
    const summary = raw === null ? null : boundRedacted(raw, redactor)
    return {
      kind: 'message',
      role: type.includes('user') ? 'user' : 'assistant',
      text: summary?.text ?? null,
      truncated: summary?.truncated ?? false,
    }
  }
  if (type.includes('command') || type.includes('exec') || type.includes('shell')) {
    const raw = item.command ?? item.commandLine
    const summary = commandSummary(raw ?? 'unknown', redactor)
    return {
      kind: 'command',
      program: summary.program,
      argumentCount: summary.argumentCount,
      quality: raw === null ? null : qualityPhaseOf(raw),
      state: itemState(method, status),
      exitCode: item.exitCode,
      durationMs: item.durationMs,
    }
  }
  if (type.includes('file') || type.includes('patch') || type.includes('diff')) {
    // Every file the change list names, not merely its first: one patch item is how the App Server
    // reports a multi-file edit, and the state is what says whether that edit was applied.
    return {
      kind: 'file',
      state: itemState(method, status),
      files: fileChangesOf(item.changes, source, redactor),
    }
  }
  if (type.includes('tool') || type.includes('search') || type.includes('mcp')) {
    return {
      kind: 'tool',
      name: bound(redactor(item.name ?? item.tool ?? item.server ?? 'tool'), 80).text,
      state: itemState(method, status),
      // Tool arguments and results routinely carry file contents and credentials, so only their
      // scale is kept.
      inputBytes: byteLength(item.input ?? item.arguments ?? item.args),
      outputBytes: byteLength(item.output ?? item.result),
    }
  }
  if (type.includes('error')) {
    const summary = boundRedacted(item.message ?? item.error ?? method, redactor)
    return {
      kind: 'error',
      severity: 'error',
      code: item.code,
      message: summary.text,
      truncated: summary.truncated,
    }
  }
  return null
}

/**
 * Normalizes one App Server message into the bounded payload the timeline retains. Anything not
 * recognized degrades to `none`: an unknown message still appears on the timeline by method name,
 * which is safe, rather than being retained verbatim, which is not.
 */
export const normalizePayload = (
  method: string,
  params: JsonValue | undefined,
  redactor: Redactor = redact,
): AgentEventPayload => {
  const source = decodeNotification(params)
  if (source !== null) {
    const payload = itemPayload(method, source.item, redactor)
    if (payload !== null) {
      return payload
    }
    const text = source.text ?? source.message
    if (text !== null && /message/iu.test(method)) {
      const summary = boundRedacted(text, redactor)
      return {
        kind: 'message',
        role: 'assistant',
        text: summary.text,
        truncated: summary.truncated,
      }
    }
  }
  if (/^thread\/|^session\/|^turn\//u.test(method)) {
    return { kind: 'session' }
  }
  return noPayload
}

/** The payload for a message the client itself emits about the session. */
export const clientPayload = (
  event: string,
  message: string | null,
  redactor: Redactor = redact,
): AgentEventPayload => {
  const summary = boundRedacted(message ?? event, redactor)
  switch (event) {
    case 'session_started':
    case 'session_stopped':
    case 'thread_started':
    case 'turn_started':
    case 'turn/terminated': {
      return { kind: 'session' }
    }
    case 'approval_auto_approved': {
      return {
        kind: 'tool',
        name: summary.text,
        state: 'approved',
        inputBytes: null,
        outputBytes: null,
      }
    }
    case 'permissions_grant_withheld': {
      return {
        kind: 'tool',
        name: summary.text,
        state: 'withheld',
        inputBytes: null,
        outputBytes: null,
      }
    }
    default: {
      return {
        kind: 'error',
        // Client-side notices — stderr noise, an unmatched response, a message Sloppenheimer could not
        // decode — are reported, but they are not by themselves session failures.
        severity: 'warning',
        code: event,
        message: summary.text,
        truncated: summary.truncated,
      }
    }
  }
}
