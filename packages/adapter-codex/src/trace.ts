/**
 * The Codex App Server's protocol messages, decoded at full fidelity for the durable agent trace.
 *
 * `payload.ts` beside this one produces the *compressed* reading the bounded operator timeline
 * retains: a command becomes its program word, a tool call becomes two byte counts, a message is
 * collapsed and cut to a couple of hundred characters. This module produces the other reading of
 * the same message, for the trace that has to answer what the agent actually did — the whole
 * command line, its stdout and stderr, the tool's arguments and its result, the patch text the
 * runner supplied.
 *
 * Both readings are produced in the same pass from the same decoded item, and both go out on one
 * `AgentEvent`. That is deliberate: two passes over one message could disagree about what it said.
 *
 * Three rules hold here and are not negotiable:
 *
 * - **Redaction first, always.** Every retained string goes through the session's own redactor —
 *   which knows the configured secret values, not only the credential shapes — before it is bounded
 *   and before it is put in a record. Nothing is redacted later, on the way out.
 * - **Reasoning summaries only.** A Codex reasoning item can carry a human-readable summary and can
 *   carry encrypted reasoning content. The summary is retained and labeled as a summary; the
 *   encrypted content is never read, never decoded, and never asked for. An item that carries only
 *   private reasoning is recorded as the *fact* that reasoning happened, which is exactly what the
 *   bounded timeline already retains.
 * - **Nothing unrecognized is stored raw.** A message no branch here recognizes becomes a list of
 *   its top-level field names, their JSON types, their sizes, and — for scalars only — their
 *   redacted values. That keeps the reconstruction complete without retaining, by default, a shape
 *   no redactor was written against.
 */

import { Schema } from 'effect'

import type { JsonValue } from '@sloppenheimer/core/domain/domain.js'
import {
  traceCaptureDisabled,
  type FieldTruncation,
  type TraceBody,
  type TraceCapture,
  type TraceCategory,
  type TraceField,
  type TraceObservation,
  type TraceOutcome,
} from '@sloppenheimer/core/domain/trace.js'
import {
  asJsonValue,
  byteLength,
  retainJson,
  retainText,
} from '@sloppenheimer/core/support/high-fidelity.js'
import { isJsonObject } from '@sloppenheimer/core/support/json.js'
import { redact, type Redactor } from '@sloppenheimer/core/support/redaction.js'
import {
  decodeOrNull,
  finiteNumber,
  nonEmptyString,
  protocolStruct,
  tolerant,
} from '@sloppenheimer/core/support/schema.js'

import { traceFileChanges } from './trace-file-changes.js'

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
 * One protocol item, read for everything the trace retains.
 *
 * `encryptedContent` and its spellings are conspicuously absent, and that absence is the point: a
 * field this schema does not name is a field this host cannot accidentally retain.
 */
const itemSource = protocolStruct({
  type: tolerant(nonEmptyString),
  itemType: tolerant(nonEmptyString),
  status: tolerant(nonEmptyString),
  state: tolerant(nonEmptyString),
  text: tolerant(Schema.String),
  content: tolerant(Schema.String),
  message: tolerant(Schema.String),
  summary: tolerant(Schema.String),
  error: tolerant(Schema.String),
  code: tolerant(nonEmptyString),
  name: tolerant(nonEmptyString),
  tool: tolerant(nonEmptyString),
  server: tolerant(nonEmptyString),
  command: tolerant(commandSource),
  commandLine: tolerant(commandSource),
  stdout: tolerant(Schema.String),
  stderr: tolerant(Schema.String),
  aggregatedOutput: tolerant(Schema.String),
  exitCode: tolerant(finiteNumber),
  durationMs: tolerant(finiteNumber),
  changes: Schema.optional(Schema.Unknown),
  input: Schema.optional(Schema.Unknown),
  arguments: Schema.optional(Schema.Unknown),
  args: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
})

const notificationSource = protocolStruct({
  item: Schema.optional(Schema.Unknown),
  text: tolerant(Schema.String),
  message: tolerant(Schema.String),
})

const decodeItem = decodeOrNull(itemSource)
const decodeNotification = decodeOrNull(notificationSource)

/** What the item's status says about how it turned out, in the trace's own vocabulary. */
const itemOutcome = (method: string, status: string | null): TraceOutcome => {
  const reported = status?.toLowerCase() ?? null
  if (reported === 'failed' || reported === 'error' || reported === 'declined') {
    return 'failed'
  }
  if (reported === 'cancelled' || reported === 'canceled' || reported === 'interrupted') {
    return 'cancelled'
  }
  if (reported === 'completed' || reported === 'succeeded' || method.endsWith('/completed')) {
    return 'succeeded'
  }
  return 'started'
}

/** The accumulator one observation is built through, so every cut it made travels with it. */
type Build = { truncations: FieldTruncation[]; redacted: boolean }

const text = (
  build: Build,
  field: string,
  value: string,
  capture: TraceCapture,
  redactor: Redactor,
): string => {
  const retained = retainText(field, value, capture.fieldLimitBytes, redactor)
  if (retained.truncation !== null) {
    build.truncations.push(retained.truncation)
  }
  build.redacted = build.redacted || retained.redacted
  return retained.text
}

const optionalText = (
  build: Build,
  field: string,
  value: string | null,
  capture: TraceCapture,
  redactor: Redactor,
): string | null => (value === null ? null : text(build, field, value, capture, redactor))

const json = (
  build: Build,
  field: string,
  value: unknown,
  capture: TraceCapture,
  redactor: Redactor,
): JsonValue | null => {
  if (value === undefined) {
    return null
  }
  const retained = retainJson(field, asJsonValue(value), capture.fieldLimitBytes, redactor)
  build.truncations.push(...retained.truncations)
  build.redacted = build.redacted || retained.redacted
  return retained.value
}

/**
 * The shape of a message nothing recognized: names, types, sizes, and the redacted rendering of
 * each scalar. A container's value is never rendered — only that it was one, and how large.
 */
export const describeFields = (
  build: Build,
  value: JsonValue | undefined,
  capture: TraceCapture,
  redactor: Redactor,
): readonly TraceField[] => {
  if (value === undefined || !isJsonObject(value)) {
    return []
  }
  return Object.entries(value).map(([name, entry]): TraceField => {
    const bytes = byteLength(JSON.stringify(entry) ?? 'null')
    if (typeof entry === 'string') {
      return { name, type: 'string', value: text(build, name, entry, capture, redactor), bytes }
    }
    if (typeof entry === 'number') {
      return { name, type: 'number', value: String(entry), bytes }
    }
    if (typeof entry === 'boolean') {
      return { name, type: 'boolean', value: String(entry), bytes }
    }
    if (entry === null) {
      return { name, type: 'null', value: null, bytes }
    }
    return { name, type: Array.isArray(entry) ? 'array' : 'object', value: null, bytes }
  })
}

const observation = (
  category: TraceCategory,
  outcome: TraceOutcome,
  body: TraceBody,
  build: Build,
): TraceObservation => ({
  category,
  outcome,
  body,
  redacted: build.redacted,
  truncations: build.truncations,
})

type DecodedItem = NonNullable<ReturnType<typeof decodeItem>>

/**
 * The reasoning branch, and the one place a privacy rule is enforced rather than described.
 *
 * A summary the runner chose to emit is retained and labeled `reasoning_summary`. An item with no
 * readable summary — the ordinary case, where the content is encrypted — records only that
 * reasoning happened, which is precisely what the bounded timeline has always retained. There is no
 * branch below that reaches for encrypted content, and there must never be one.
 */
const reasoningBody = (
  item: DecodedItem,
  build: Build,
  capture: TraceCapture,
  redactor: Redactor,
): TraceBody => {
  const summary = item.summary ?? item.text ?? item.content
  if (summary === null || summary.trim().length === 0) {
    return {
      kind: 'lifecycle',
      phase: 'reasoning',
      detail: 'the runner emitted no human-readable reasoning summary for this item',
    }
  }
  return {
    kind: 'reasoning_summary',
    text: text(build, 'summary', summary, capture, redactor),
  }
}

const commandBody = (
  item: DecodedItem,
  build: Build,
  capture: TraceCapture,
  redactor: Redactor,
): TraceBody => ({
  kind: 'command',
  // The whole line, arguments included. The compressed timeline keeps the program word alone
  // because it is a health summary; a trace that dropped the arguments could not say what ran.
  commandLine: text(
    build,
    'commandLine',
    item.command ?? item.commandLine ?? '',
    capture,
    redactor,
  ),
  stdout: optionalText(build, 'stdout', item.stdout ?? item.aggregatedOutput, capture, redactor),
  stderr: optionalText(build, 'stderr', item.stderr, capture, redactor),
  exitCode: item.exitCode,
  durationMs: item.durationMs,
})

const bodyOf = (
  method: string,
  item: DecodedItem,
  build: Build,
  capture: TraceCapture,
  redactor: Redactor,
): Readonly<{ category: TraceCategory; body: TraceBody }> | null => {
  const type = (item.type ?? item.itemType ?? '').toLowerCase()
  if (type.includes('reasoning')) {
    const body = reasoningBody(item, build, capture, redactor)
    return { category: body.kind === 'reasoning_summary' ? 'reasoning_summary' : 'lifecycle', body }
  }
  if (type.includes('message')) {
    return {
      category: 'message',
      body: {
        kind: 'message',
        role: type.includes('user') ? 'user' : 'assistant',
        text: text(
          build,
          'text',
          item.text ?? item.content ?? item.message ?? '',
          capture,
          redactor,
        ),
      },
    }
  }
  if (type.includes('command') || type.includes('exec') || type.includes('shell')) {
    return { category: 'command', body: commandBody(item, build, capture, redactor) }
  }
  if (type.includes('file') || type.includes('patch') || type.includes('diff')) {
    return {
      category: 'file',
      body: { kind: 'file', files: traceFileChanges(item.changes, build, capture, redactor) },
    }
  }
  if (type.includes('tool') || type.includes('search') || type.includes('mcp')) {
    return {
      category: 'tool',
      body: {
        kind: 'tool',
        name: text(
          build,
          'name',
          item.name ?? item.tool ?? item.server ?? 'tool',
          capture,
          redactor,
        ),
        arguments: json(
          build,
          'arguments',
          item.input ?? item.arguments ?? item.args,
          capture,
          redactor,
        ),
        result: json(build, 'result', item.output ?? item.result, capture, redactor),
        durationMs: item.durationMs,
      },
    }
  }
  if (type.includes('error')) {
    return {
      category: 'error',
      body: {
        kind: 'error',
        severity: 'error',
        code: item.code,
        message: text(build, 'message', item.message ?? item.error ?? method, capture, redactor),
      },
    }
  }
  return null
}

/**
 * The high-fidelity reading of one App Server message, or `null` while capture is off.
 *
 * `null` rather than an empty observation, because the caller puts it straight on the event: a host
 * with tracing disabled builds nothing, redacts nothing, and retains nothing.
 */
export const traceObservation = (
  method: string,
  params: JsonValue | undefined,
  capture: TraceCapture = traceCaptureDisabled,
  redactor: Redactor = redact,
): TraceObservation | null => {
  if (!capture.enabled) {
    return null
  }
  const build: Build = { truncations: [], redacted: false }
  const source = decodeNotification(params)
  if (source !== null) {
    const item = decodeItem(source.item)
    if (item !== null) {
      const reading = bodyOf(method, item, build, capture, redactor)
      if (reading !== null) {
        return observation(
          reading.category,
          itemOutcome(method, item.status ?? item.state),
          reading.body,
          build,
        )
      }
    }
    const free = source.text ?? source.message
    if (free !== null && /message/iu.test(method)) {
      return observation(
        'message',
        'informational',
        { kind: 'message', role: 'assistant', text: text(build, 'text', free, capture, redactor) },
        build,
      )
    }
  }
  if (/^thread\/|^session\/|^turn\//u.test(method)) {
    return observation(
      'lifecycle',
      'informational',
      { kind: 'lifecycle', phase: method, detail: null },
      build,
    )
  }
  return observation(
    'unknown',
    'informational',
    { kind: 'unknown', fields: describeFields(build, params, capture, redactor) },
    build,
  )
}

/**
 * The high-fidelity reading of a message the client itself emits about the session: an approval it
 * answered, a grant it withheld, or a notice about its own protocol handling.
 */
export const clientTraceObservation = (
  event: string,
  message: string | null,
  capture: TraceCapture = traceCaptureDisabled,
  redactor: Redactor = redact,
): TraceObservation | null => {
  if (!capture.enabled) {
    return null
  }
  const build: Build = { truncations: [], redacted: false }
  const subject = text(build, 'subject', message ?? event, capture, redactor)
  switch (event) {
    case 'session_started':
    case 'session_stopped':
    case 'thread_started':
    case 'turn_started':
    case 'turn/terminated': {
      return observation(
        'lifecycle',
        'informational',
        { kind: 'lifecycle', phase: event, detail: message === null ? null : subject },
        build,
      )
    }
    case 'approval_auto_approved': {
      return observation(
        'approval',
        'approved',
        { kind: 'approval', subject, decision: 'acceptForSession' },
        build,
      )
    }
    case 'permissions_grant_withheld': {
      return observation(
        'approval',
        'withheld',
        { kind: 'approval', subject, decision: 'withheld' },
        build,
      )
    }
    default: {
      return observation(
        'error',
        'failed',
        // A client-side notice — stderr noise, an unmatched response, a line that would not decode
        // — is reported, and is not by itself a session failure. `severity` says which.
        { kind: 'error', severity: 'warning', code: event, message: subject },
        build,
      )
    }
  }
}

export type { Build as TraceBuild }
