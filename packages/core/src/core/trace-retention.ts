import type { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { TraceStoreError } from '../domain/errors.js'
import type { TraceEviction, TraceLimits } from '../domain/trace.js'
import { loadStoreDocument, saveStoreDocument, type StoreFailure } from './json-store.js'
import {
  listSegments,
  removeSegment,
  segmentBytes,
  type TraceSegment,
} from './trace-store.js'

/**
 * Retention for the durable trace: which segments go, in what order, and the record of what went.
 *
 * Two bounds, applied in this order, and both deterministic — the same segments and the same
 * instant always evict the same set:
 *
 * 1. **Age.** A segment older than `retentionMs` goes, whatever the total size is. `0` turns the
 *    age bound off and leaves the size bound as the only one.
 * 2. **Total size.** While the remainder exceeds `totalLimitBytes`, the oldest goes next.
 *
 * Ordering comes from the segment's own file name rather than from a filesystem timestamp, so a
 * host reading segments another host wrote does not compare its clock against a foreign mtime.
 *
 * Nothing is ever evicted silently. Every deletion is appended to `evictions.json` beside the
 * segments, and the operator API publishes that list next to the limits that produced it, because
 * retention that removed an operator's evidence has to be an answer rather than an absence. The
 * record is itself bounded, and it says so the same way: the oldest entries fall off the front.
 *
 * The segment a run is writing to right now is never a candidate. Deleting the file under a live
 * append would lose the run this trace exists to explain, and the ceiling it is subject to is its
 * own `sessionLimitBytes`, enforced by the recorder as it writes.
 */

/** How many evictions the record keeps. Older entries fall off the front, which is itself visible. */
export const retainedEvictions = 50

const evictionRecord = Schema.Struct({
  identifier: Schema.String,
  runId: Schema.Number,
  startedAt: Schema.String,
  bytes: Schema.Number,
  reason: Schema.Literal('age', 'total_size'),
  evictedAt: Schema.String,
}).annotations({ message: () => 'trace eviction record is malformed' })

/** Versioned at the envelope so a future format is added as another schema union member. */
const evictionStoreV1 = Schema.Struct({
  version: Schema.Literal(1),
  /** How many evictions this host has ever recorded, so a trimmed list is not read as the total. */
  total: Schema.Number,
  evictions: Schema.Array(evictionRecord),
}).annotations({ message: () => 'trace eviction store envelope is not version 1' })

const label = 'trace eviction store'

const fail: StoreFailure<TraceStoreError> = (operation, message, cause) =>
  new TraceStoreError({ operation, message, cause })

export type EvictionLog = Readonly<{
  total: number
  evictions: readonly TraceEviction[]
}>

export const emptyEvictionLog: EvictionLog = Object.freeze({ total: 0, evictions: [] })

export const loadEvictions = (
  path: string,
): Effect.Effect<EvictionLog, TraceStoreError, FileSystem.FileSystem> =>
  loadStoreDocument({
    path,
    label,
    schema: evictionStoreV1,
    absent: { version: 1, total: 0, evictions: [] } as const,
    fail,
  }).pipe(Effect.map(({ total, evictions }) => ({ total, evictions })))

export const saveEvictions = (
  path: string,
  log: EvictionLog,
): Effect.Effect<void, TraceStoreError, FileSystem.FileSystem> =>
  saveStoreDocument({
    path,
    label,
    document: { version: 1, total: log.total, evictions: log.evictions },
    fail,
  })

/** One segment measured, so the decision below is made against sizes rather than against files. */
type MeasuredSegment = Readonly<{ segment: TraceSegment; bytes: number }>

/**
 * Which segments the two bounds evict, and why.
 *
 * Pure, so the policy can be exercised without a filesystem: the ages, the sizes and the instant go
 * in, and the eviction list comes out in the order the pass will apply it.
 */
export type PlannedEviction = Readonly<{
  segment: TraceSegment
  bytes: number
  reason: 'age' | 'total_size'
}>

export const evictionPlan = (
  measured: readonly MeasuredSegment[],
  limits: TraceLimits,
  nowMs: number,
): readonly PlannedEviction[] => {
  const aged =
    limits.retentionMs > 0
      ? measured.filter((entry) => nowMs - entry.segment.startedAtMs > limits.retentionMs)
      : []
  const evicted = new Set(aged.map((entry) => entry.segment.path))
  const plan: PlannedEviction[] = aged.map((entry) => ({ ...entry, reason: 'age' }))
  let remaining = measured
    .filter((entry) => !evicted.has(entry.segment.path))
    .reduce((total, entry) => total + entry.bytes, 0)
  for (const entry of measured) {
    if (remaining <= limits.totalLimitBytes) {
      break
    }
    if (evicted.has(entry.segment.path)) {
      continue
    }
    evicted.add(entry.segment.path)
    remaining -= entry.bytes
    plan.push({ ...entry, reason: 'total_size' })
  }
  return plan
}

/**
 * Applies the plan and records it.
 *
 * The eviction log is written after the deletions rather than before: a log naming a segment that
 * is still on disk would report evidence as gone while it was still there, and the reverse — a
 * deleted segment this host has not yet recorded — is corrected by the next pass reading a
 * directory that no longer holds it.
 */
export const pruneTraces = (
  traceRoot: string,
  evictionPath: string,
  limits: TraceLimits,
  nowMs: number,
  /** The segment a run is appending to, which is never a candidate. */
  activePaths: ReadonlySet<string>,
): Effect.Effect<readonly TraceEviction[], TraceStoreError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const segments = yield* listSegments(traceRoot)
    const candidates = segments.filter((segment) => !activePaths.has(segment.path))
    const measured: MeasuredSegment[] = []
    for (const segment of candidates) {
      measured.push({ segment, bytes: yield* segmentBytes(segment.path) })
    }
    const plan = evictionPlan(measured, limits, nowMs)
    if (plan.length === 0) {
      return []
    }
    const evictedAt = new Date(nowMs).toISOString()
    const evictions: TraceEviction[] = []
    for (const entry of plan) {
      yield* removeSegment(entry.segment.path)
      evictions.push({
        // The directory key, not the tracker's spelling: the segment's own name is what this pass
        // read, and re-deriving an identifier from a sanitized key would be a guess.
        identifier: entry.segment.identifierKey,
        runId: entry.segment.runId,
        startedAt: new Date(entry.segment.startedAtMs).toISOString(),
        bytes: entry.bytes,
        reason: entry.reason,
        evictedAt,
      })
    }
    const existing = yield* loadEvictions(evictionPath)
    yield* saveEvictions(evictionPath, {
      total: existing.total + evictions.length,
      evictions: [...existing.evictions, ...evictions].slice(-retainedEvictions),
    })
    return evictions
  })
