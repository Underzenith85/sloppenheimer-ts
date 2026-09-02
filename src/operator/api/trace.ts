// The published shape of the durable high-fidelity agent trace, and the query a request states it
// with.
//
// It follows the same convention as every other document this server sends: snake_case on the
// wire, `null` for absence, instants as ISO strings. The mapping lives here rather than in the
// runtime for the reason `api.ts` gives — `TraceEvent` is also the value the runtime writes to disk
// and streams to a subscriber, and renaming its fields to match the wire would push a published
// vocabulary back into the store.
//
// The body of an event is published as it is recorded, key for key. It is the one part of this
// document that is not re-spelled: a trace body is already a closed union of plain JSON, the
// console renders it by `kind`, and re-spelling it here would mean maintaining a second copy of a
// vocabulary whose whole purpose is to be an exact record.

import type {
  TraceCategory,
  TraceEvent,
  TraceEviction,
  TraceLimits,
  TraceOutcome,
} from '@sloppenheimer/core/domain/trace.js'
import { traceCategories, traceOutcomes } from '@sloppenheimer/core/domain/trace.js'
import type { TracePage, TraceQuery } from '@sloppenheimer/core'

/** The versioned trace resource for one issue, and the live tail beside it. */
export const tracePath = (identifier: string): string =>
  `/api/v1/agents/${encodeURIComponent(identifier)}/trace`

export const traceStreamPath = (identifier: string): string => `${tracePath(identifier)}/stream`

export type PublishedTraceTruncation = Readonly<{
  field: string
  reason: string
  retained_bytes: number
  original_bytes: number | null
}>

export type PublishedTraceEvent = Readonly<{
  sequence: number
  recorded_at: string
  issue_id: string
  identifier: string
  run_id: number
  attempt: number
  thread_id: string | null
  turn_id: string | null
  session_id: string | null
  turn_number: number
  event: string
  category: TraceCategory
  outcome: TraceOutcome
  /** The recorded body, published key for key. See this module's header for why it is not respelled. */
  body: TraceEvent['body']
  redacted: boolean
  truncations: readonly PublishedTraceTruncation[]
}>

export type PublishedTraceLimits = Readonly<{
  field_limit_bytes: number
  event_limit_bytes: number
  session_limit_bytes: number
  total_limit_bytes: number
  retention_ms: number
}>

export type PublishedTraceEviction = Readonly<{
  identifier: string
  run_id: number
  started_at: string
  bytes: number
  reason: string
  evicted_at: string
}>

/**
 * One page.
 *
 * `enabled` is published even when it is `false`, and it is the field a reader has to consult
 * first: a host with capture off has no history at all, which is a different answer from a filter
 * that matched nothing. `malformed_records` and `evictions` are published for the same reason —
 * every gap in the reconstruction is named rather than left to be inferred from an absence.
 */
export type PublishedTrace = Readonly<{
  version: 'v1'
  enabled: boolean
  identifier: string
  events: readonly PublishedTraceEvent[]
  next_after: number
  has_more: boolean
  malformed_records: number
  limits: PublishedTraceLimits
  evictions: readonly PublishedTraceEviction[]
  evictions_total: number
}>

const publishTruncations = (
  truncations: TraceEvent['truncations'],
): readonly PublishedTraceTruncation[] =>
  truncations.map((truncation) => ({
    field: truncation.field,
    reason: truncation.reason,
    retained_bytes: truncation.retainedBytes,
    original_bytes: truncation.originalBytes,
  }))

export const publishTraceEvent = (event: TraceEvent): PublishedTraceEvent => ({
  sequence: event.sequence,
  recorded_at: event.recordedAt,
  issue_id: event.issueId,
  identifier: event.identifier,
  run_id: event.runId,
  attempt: event.attempt,
  thread_id: event.threadId,
  turn_id: event.turnId,
  session_id: event.sessionId,
  turn_number: event.turnCount,
  event: event.event,
  category: event.category,
  outcome: event.outcome,
  body: event.body,
  redacted: event.redacted,
  truncations: publishTruncations(event.truncations),
})

const publishLimits = (limits: TraceLimits): PublishedTraceLimits => ({
  field_limit_bytes: limits.fieldLimitBytes,
  event_limit_bytes: limits.eventLimitBytes,
  session_limit_bytes: limits.sessionLimitBytes,
  total_limit_bytes: limits.totalLimitBytes,
  retention_ms: limits.retentionMs,
})

const publishEviction = (eviction: TraceEviction): PublishedTraceEviction => ({
  identifier: eviction.identifier,
  run_id: eviction.runId,
  started_at: eviction.startedAt,
  bytes: eviction.bytes,
  reason: eviction.reason,
  evicted_at: eviction.evictedAt,
})

export const publishTrace = (page: TracePage): PublishedTrace => ({
  version: 'v1',
  enabled: page.enabled,
  identifier: page.identifier,
  events: page.events.map(publishTraceEvent),
  next_after: page.nextAfter,
  has_more: page.hasMore,
  malformed_records: page.malformedRecords,
  limits: publishLimits(page.limits),
  evictions: page.evictions.map(publishEviction),
  evictions_total: page.evictionsTotal,
})

/**
 * A comma-separated filter, kept only where every member is one this host knows.
 *
 * An unknown member fails the whole parameter rather than being dropped, because a filter silently
 * narrowed to the members that happened to be recognized would show an operator fewer events than
 * they asked for and give them no way to tell.
 */
const membersOf = <Member extends string>(
  raw: string | null,
  known: readonly Member[],
): readonly Member[] | null | 'invalid' => {
  if (raw === null || raw.trim().length === 0) {
    return null
  }
  const requested = raw
    .split(',')
    .map((member) => member.trim())
    .filter((member) => member.length > 0)
  const isKnown = (member: string): member is Member =>
    known.some((candidate) => candidate === member)
  const matched = requested.filter(isKnown)
  return matched.length === requested.length && matched.length > 0 ? matched : 'invalid'
}

const positiveInteger = (raw: string | null): number | null | 'invalid' => {
  if (raw === null || raw.trim().length === 0) {
    return null
  }
  return /^\d+$/u.test(raw.trim()) ? Number(raw.trim()) : 'invalid'
}

/** The query a trace request states, or the name of the parameter that refused it. */
export type TraceQueryResult =
  | Readonly<{ _tag: 'Query'; query: TraceQuery }>
  | Readonly<{ _tag: 'Invalid'; parameter: string }>

/**
 * Reads a trace query off a URL.
 *
 * Every parameter is optional and a malformed one is refused by name, which is what lets the
 * console's own filters be a deep link an operator can share.
 */
export const traceQueryFrom = (parameters: URLSearchParams, limit: number): TraceQueryResult => {
  const after = positiveInteger(parameters.get('after'))
  if (after === 'invalid') {
    return { _tag: 'Invalid', parameter: 'after' }
  }
  const requestedLimit = positiveInteger(parameters.get('limit'))
  if (requestedLimit === 'invalid') {
    return { _tag: 'Invalid', parameter: 'limit' }
  }
  const attempt = positiveInteger(parameters.get('attempt'))
  if (attempt === 'invalid') {
    return { _tag: 'Invalid', parameter: 'attempt' }
  }
  const categories = membersOf<TraceCategory>(parameters.get('category'), traceCategories)
  if (categories === 'invalid') {
    return { _tag: 'Invalid', parameter: 'category' }
  }
  const outcomes = membersOf<TraceOutcome>(parameters.get('outcome'), traceOutcomes)
  if (outcomes === 'invalid') {
    return { _tag: 'Invalid', parameter: 'outcome' }
  }
  const turnId = parameters.get('turn_id')
  return {
    _tag: 'Query',
    query: {
      after: after ?? 0,
      limit: Math.min(requestedLimit ?? limit, limit),
      categories,
      outcomes,
      attempt,
      turnId: turnId === null || turnId.length === 0 ? null : turnId,
    },
  }
}
