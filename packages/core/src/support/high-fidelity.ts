/**
 * Redaction and bounding for values that are retained *whole* rather than summarized.
 *
 * `support/redaction.ts` is the bounded-telemetry vocabulary: it collapses whitespace, cuts at a
 * couple of hundred characters, and reduces a command to its program word, because the operator
 * timeline exists to answer "is this healthy" and nothing more. A durable agent trace answers a
 * different question — "what did this agent actually do" — and a summary cannot answer it. So this
 * module keeps the same redactors and drops the summarizing: newlines survive, arguments survive,
 * tool payloads survive.
 *
 * What replaces the summarizing is an explicit byte ceiling per field and per event. Nothing here
 * is unbounded, and no cut is silent: every truncation is reported as a {@link FieldTruncation}
 * that travels with the value it shortened, so an operator reading a trace can always tell a
 * command that printed nothing from one whose output was cut.
 *
 * Redaction runs before bounding, for the reason `boundRedacted` already states: a secret cut in
 * half is still a leak. And it runs here, at ingest, rather than at serialization, for the reason
 * `support/redaction.ts` already states: a value redacted on the way out was resident in memory
 * the whole time.
 *
 * The deliberate limit, which `README.md` states to operators: this is heuristic. It removes the
 * secrets the host was configured with and the credential shapes it recognizes, and it cannot
 * remove an arbitrary secret embedded in ordinary source text that an agent happened to print.
 */

import { isJsonArray, isJsonObject, type JsonValue } from './json.js'
import { isSecretKey, redact, redactionMarker, type Redactor } from './redaction.js'

/** One field that did not fit, named so that a reader can see exactly what was shortened. */
export type FieldTruncation = Readonly<{
  /** The field's path within the event, such as `stdout` or `arguments.files`. */
  field: string
  /**
   * Why it was shortened: it exceeded the byte ceiling, it was nested past the depth floor, or the
   * collection it belonged to held more entries than one event may carry.
   */
  reason: 'byte_limit' | 'depth_limit' | 'count_limit'
  /** Bytes retained, or — for a `count_limit` — entries retained. */
  retainedBytes: number
  /** The size before the cut, in the same unit. `null` where the cut was structural. */
  originalBytes: number | null
}>

export type RetainedText = Readonly<{
  text: string
  truncation: FieldTruncation | null
  /** Whether the redactor removed anything on the way in. */
  redacted: boolean
}>

export type RetainedJson = Readonly<{
  value: JsonValue
  truncations: readonly FieldTruncation[]
  redacted: boolean
}>

/**
 * How deep a retained JSON payload is walked. A structure below this is replaced by the marker
 * rather than followed: an agent controls the shape of its own tool arguments, and a walk with no
 * floor is a stack the agent chose the depth of.
 */
const maximumDepth = 16

/** The marker a value replaced for structural reasons carries, distinct from the secret marker. */
export const truncationMarker = '[TRUNCATED]'

export const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8')

/**
 * Cuts a string to a byte ceiling without splitting a code point. The ceiling is in bytes rather
 * than characters because it exists to bound storage, and one emoji is four bytes of it.
 */
export const cutToBytes = (value: string, limit: number): string => {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= limit) {
    return value
  }
  let end = Math.max(limit, 0)
  // Step back over the continuation bytes of a sequence the cut landed inside.
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1
  }
  return buffer.subarray(0, end).toString('utf8')
}

/**
 * The retained form of one free-text field: redacted, then cut to the ceiling, with the cut
 * reported. Whitespace is preserved exactly — a command's output is not the same document once its
 * newlines are collapsed.
 */
export const retainText = (
  field: string,
  value: string,
  limit: number,
  redactor: Redactor = redact,
): RetainedText => {
  const cleaned = redactor(value)
  const originalBytes = byteLength(cleaned)
  const redacted = cleaned !== value
  if (originalBytes <= limit) {
    return { text: cleaned, truncation: null, redacted }
  }
  const text = cutToBytes(cleaned, limit)
  return {
    text,
    truncation: { field, reason: 'byte_limit', retainedBytes: byteLength(text), originalBytes },
    redacted,
  }
}

/** The accumulator a JSON walk fills as it goes, so one pass reports everything it did. */
type JsonWalk = {
  truncations: FieldTruncation[]
  redacted: boolean
}

const retainScalar = (
  field: string,
  value: string,
  limit: number,
  redactor: Redactor,
  walk: JsonWalk,
): string => {
  const retained = retainText(field, value, limit, redactor)
  if (retained.truncation !== null) {
    walk.truncations.push(retained.truncation)
  }
  walk.redacted = walk.redacted || retained.redacted
  return retained.text
}

const walkJson = (
  field: string,
  value: JsonValue,
  limit: number,
  redactor: Redactor,
  depth: number,
  walk: JsonWalk,
): JsonValue => {
  if (typeof value === 'string') {
    return retainScalar(field, value, limit, redactor, walk)
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (depth >= maximumDepth) {
    walk.truncations.push({ field, reason: 'depth_limit', retainedBytes: 0, originalBytes: null })
    return truncationMarker
  }
  if (isJsonArray(value)) {
    return value.map((entry, index) =>
      walkJson(`${field}[${String(index)}]`, entry, limit, redactor, depth + 1, walk),
    )
  }
  const entries: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      // A value under a secret-named key never reaches the walk: its shape is not worth the risk
      // of retaining any part of it.
      entries[key] = redactionMarker
      walk.redacted = true
      continue
    }
    entries[key] = walkJson(`${field}.${key}`, entry, limit, redactor, depth + 1, walk)
  }
  return entries
}

/**
 * The retained form of a structured payload — a tool's arguments or its result.
 *
 * Every string inside it is redacted and cut to the per-field ceiling, and every value under a
 * secret-named key is replaced outright. The whole payload is then measured: one that still
 * exceeds the ceiling is replaced by the cut text of its own JSON rendering, which keeps the
 * beginning of it readable rather than dropping the payload entirely, and says so in a truncation.
 */
export const retainJson = (
  field: string,
  value: JsonValue,
  limit: number,
  redactor: Redactor = redact,
): RetainedJson => {
  const walk: JsonWalk = { truncations: [], redacted: false }
  const retained = walkJson(field, value, limit, redactor, 0, walk)
  const rendered = JSON.stringify(retained) ?? 'null'
  const renderedBytes = byteLength(rendered)
  if (renderedBytes <= limit) {
    return { value: retained, truncations: walk.truncations, redacted: walk.redacted }
  }
  const cut = cutToBytes(rendered, limit)
  return {
    value: cut,
    truncations: [
      ...walk.truncations,
      { field, reason: 'byte_limit', retainedBytes: byteLength(cut), originalBytes: renderedBytes },
    ],
    redacted: walk.redacted,
  }
}

/**
 * A value that arrived as `unknown` — a protocol payload nothing decoded — reduced to exact JSON
 * so the walk above can be applied to it. Anything JSON cannot carry is dropped rather than
 * coerced: a retained trace has to round-trip through a file.
 */
export const asJsonValue = (value: unknown, depth = 0): JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value
  }
  if (depth >= maximumDepth) {
    // A protocol payload is another program's value, so its depth is not this host's to trust.
    return truncationMarker
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => asJsonValue(entry, depth + 1))
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]: readonly [string, unknown]) => [
        key,
        asJsonValue(entry, depth + 1),
      ]),
    )
  }
  return null
}
