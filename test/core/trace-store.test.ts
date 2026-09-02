import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileSystem } from '@effect/platform'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { issueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import type { TraceEvent, TraceLimits } from '@sloppenheimer/core/domain/trace.js'
import {
  evictionPlan,
  loadEvictions,
  pruneTraces,
  retainedEvictions,
} from '@sloppenheimer/core/core/trace-retention.js'
import {
  appendTraceEvent,
  evictionPath,
  listSegments,
  parseSegmentName,
  readSegment,
  segmentPath,
  traceRoot,
  type TraceSegment,
} from '@sloppenheimer/core/core/trace-store.js'
import { hostFileSystem } from '../harness/filesystem.js'

/**
 * The durable trace on disk: what an append leaves, what a torn write costs, and what retention
 * takes.
 *
 * These run against real files rather than a stub, because every property under test is a property
 * of the filesystem: that a second append does not rewrite the first, that a half-written last line
 * does not cost the lines before it, and that a path derived from a tracker's own spelling of an
 * identifier cannot leave the directory it was given.
 */

const onHost = <Value, Error>(
  effect: Effect.Effect<Value, Error, FileSystem.FileSystem>,
): Effect.Effect<Value, Error> => Effect.provide(effect, hostFileSystem)

const directories: string[] = []

const makeRoot = (): Effect.Effect<string> =>
  Effect.promise(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppenheimer-trace-'))
    directories.push(directory)
    return directory
  })

afterEach(async (): Promise<void> => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const event = (sequence: number, overrides: Partial<TraceEvent> = {}): TraceEvent => ({
  version: 1,
  sequence,
  recordedAt: new Date(sequence * 1000).toISOString(),
  issueId: '18',
  identifier: 'example/sloppenheimer#18',
  runId: 1,
  attempt: 0,
  threadId: 'thread-1',
  turnId: 'turn-1',
  sessionId: 'thread-1-turn-1',
  turnCount: 1,
  event: 'item/completed',
  category: 'message',
  outcome: 'succeeded',
  body: { kind: 'message', role: 'assistant', text: `record ${String(sequence)}` },
  redacted: false,
  truncations: [],
  ...overrides,
})

const limits: TraceLimits = {
  fieldLimitBytes: 4096,
  eventLimitBytes: 8192,
  sessionLimitBytes: 65_536,
  totalLimitBytes: 1_000_000,
  retentionMs: 0,
}

const openSegment = (
  root: string,
  identifier: string,
  runId: number,
  startedAtMs: number,
): Effect.Effect<TraceSegment> =>
  onHost(segmentPath(traceRoot(root), issueIdentifier(identifier), runId, startedAtMs)).pipe(
    Effect.orDie,
  )

describe('appending trace records', (): void => {
  it.effect('leaves every earlier record untouched', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const segment = yield* openSegment(root, 'example/sloppenheimer#18', 1, 1_000)
      for (const sequence of [1, 2, 3]) {
        yield* onHost(appendTraceEvent(segment, event(sequence))).pipe(Effect.orDie)
      }
      const contents = yield* onHost(readSegment(segment.path)).pipe(Effect.orDie)
      expect(contents.events.map((record) => record.sequence)).toEqual([1, 2, 3])
      expect(contents.malformed).toBe(0)
    }),
  )

  it.effect('reads every good record beside a line an interrupted write tore', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const segment = yield* openSegment(root, 'example/sloppenheimer#18', 1, 1_000)
      yield* onHost(appendTraceEvent(segment, event(1))).pipe(Effect.orDie)
      yield* onHost(appendTraceEvent(segment, event(2))).pipe(Effect.orDie)
      // Exactly what a process killed mid-append leaves: a prefix of one line, no newline.
      yield* Effect.promise(() =>
        appendFile(segment.path, `${JSON.stringify(event(3)).slice(0, 40)}`, 'utf8'),
      )
      const contents = yield* onHost(readSegment(segment.path)).pipe(Effect.orDie)
      expect(contents.events.map((record) => record.sequence)).toEqual([1, 2])
      expect(contents.malformed).toBe(1)
      // And the segment keeps working: the next append lands after the tear.
      yield* Effect.promise(() => appendFile(segment.path, '\n', 'utf8'))
      yield* onHost(appendTraceEvent(segment, event(4))).pipe(Effect.orDie)
      const after = yield* onHost(readSegment(segment.path)).pipe(Effect.orDie)
      expect(after.events.map((record) => record.sequence)).toEqual([1, 2, 4])
    }),
  )

  it.effect('counts a line this host cannot decode rather than failing the read', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const segment = yield* openSegment(root, 'example/sloppenheimer#18', 1, 1_000)
      yield* onHost(appendTraceEvent(segment, event(1))).pipe(Effect.orDie)
      yield* Effect.promise(() =>
        appendFile(segment.path, `${JSON.stringify({ version: 9, nonsense: true })}\n`, 'utf8'),
      )
      const contents = yield* onHost(readSegment(segment.path)).pipe(Effect.orDie)
      expect(contents.events).toHaveLength(1)
      expect(contents.malformed).toBe(1)
    }),
  )

  it.effect('answers an empty read for a segment that was never written', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const contents = yield* onHost(readSegment(join(root, 'absent.jsonl'))).pipe(Effect.orDie)
      expect(contents).toEqual({ events: [], malformed: 0 })
    }),
  )
})

describe('naming a segment', (): void => {
  it.effect('keeps an identifier that would otherwise escape the trace directory', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const segment = yield* openSegment(root, '../../etc/passwd', 1, 1_000)
      expect(segment.path.startsWith(traceRoot(root))).toBe(true)
      expect(segment.identifierKey).not.toContain('/')
    }),
  )

  it.effect('separates two issues and two runs into segments of their own', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const first = yield* openSegment(root, 'example/sloppenheimer#18', 1, 1_000)
      const second = yield* openSegment(root, 'example/sloppenheimer#18', 2, 2_000)
      const other = yield* openSegment(root, 'example/sloppenheimer#19', 1, 3_000)
      for (const segment of [first, second, other]) {
        yield* onHost(appendTraceEvent(segment, event(1))).pipe(Effect.orDie)
      }
      const segments = yield* onHost(listSegments(traceRoot(root))).pipe(Effect.orDie)
      expect(segments).toHaveLength(3)
      // Oldest first, from the names alone, with no filesystem timestamp consulted.
      expect(segments.map((entry) => entry.startedAtMs)).toEqual([1_000, 2_000, 3_000])
    }),
  )

  it('reads the instant and the run back out of a segment name', (): void => {
    expect(parseSegmentName('00000000001000-7.jsonl')).toEqual({ startedAtMs: 1000, runId: 7 })
    expect(parseSegmentName('notes.txt')).toBeNull()
  })

  it.effect('ignores a directory entry that is not a segment', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const segment = yield* openSegment(root, 'example/sloppenheimer#18', 1, 1_000)
      yield* onHost(appendTraceEvent(segment, event(1))).pipe(Effect.orDie)
      yield* Effect.promise(async () => {
        await writeFile(join(traceRoot(root), 'evictions.json'), '{}', 'utf8')
        await mkdir(join(traceRoot(root), 'unrelated'), { recursive: true })
      })
      const segments = yield* onHost(listSegments(traceRoot(root))).pipe(Effect.orDie)
      expect(segments).toHaveLength(1)
    }),
  )
})

describe('retention', (): void => {
  const measured = (
    startedAtMs: number,
    bytes: number,
  ): Readonly<{
    segment: TraceSegment
    bytes: number
  }> => ({
    segment: {
      identifierKey: 'example_sloppenheimer_18',
      fileName: `${String(startedAtMs)}.jsonl`,
      path: `/traces/example_sloppenheimer_18/${String(startedAtMs)}.jsonl`,
      runId: 1,
      startedAtMs,
    },
    bytes,
  })

  it('evicts by age first and by total size afterwards', (): void => {
    const plan = evictionPlan(
      [measured(1_000, 100), measured(2_000, 100), measured(3_000, 100)],
      { ...limits, retentionMs: 1_500, totalLimitBytes: 100 },
      3_000,
    )
    expect(plan.map((entry) => [entry.segment.startedAtMs, entry.reason])).toEqual([
      [1_000, 'age'],
      [2_000, 'total_size'],
    ])
  })

  it('evicts nothing while both bounds are satisfied', (): void => {
    expect(evictionPlan([measured(1_000, 10)], limits, 2_000)).toEqual([])
  })

  it('leaves every segment when the age bound is switched off and size allows', (): void => {
    const plan = evictionPlan([measured(0, 10), measured(1, 10)], limits, 1_000_000_000)
    expect(plan).toEqual([])
  })

  it.effect('deletes the segments it planned and records why', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const old = yield* openSegment(root, 'example/sloppenheimer#18', 1, 1_000)
      const recent = yield* openSegment(root, 'example/sloppenheimer#18', 2, 500_000)
      for (const segment of [old, recent]) {
        yield* onHost(appendTraceEvent(segment, event(1))).pipe(Effect.orDie)
      }
      const evictions = yield* onHost(
        pruneTraces(
          traceRoot(root),
          evictionPath(root),
          { ...limits, retentionMs: 10_000 },
          505_000,
          new Set(),
        ),
      ).pipe(Effect.orDie)
      expect(evictions.map((entry) => entry.reason)).toEqual(['age'])
      const remaining = yield* onHost(listSegments(traceRoot(root))).pipe(Effect.orDie)
      expect(remaining.map((entry) => entry.path)).toEqual([recent.path])
      const log = yield* onHost(loadEvictions(evictionPath(root))).pipe(Effect.orDie)
      expect(log.total).toBe(1)
      expect(log.evictions[0]?.runId).toBe(1)
    }),
  )

  it.effect('never takes the segment a run is writing to', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const active = yield* openSegment(root, 'example/sloppenheimer#18', 1, 1_000)
      yield* onHost(appendTraceEvent(active, event(1))).pipe(Effect.orDie)
      const evictions = yield* onHost(
        pruneTraces(
          traceRoot(root),
          evictionPath(root),
          { ...limits, retentionMs: 1, totalLimitBytes: 0 },
          600_000,
          new Set([active.path]),
        ),
      ).pipe(Effect.orDie)
      expect(evictions).toEqual([])
      expect(yield* onHost(readSegment(active.path)).pipe(Effect.orDie)).toMatchObject({
        malformed: 0,
      })
    }),
  )

  it.effect('keeps the eviction record bounded and still reports the true total', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const total = retainedEvictions + 5
      for (let index = 0; index < total; index += 1) {
        const segment = yield* openSegment(root, 'example/sloppenheimer#18', index, 1_000 + index)
        yield* onHost(appendTraceEvent(segment, event(1))).pipe(Effect.orDie)
      }
      yield* onHost(
        pruneTraces(
          traceRoot(root),
          evictionPath(root),
          { ...limits, retentionMs: 1 },
          600_000,
          new Set(),
        ),
      ).pipe(Effect.orDie)
      const log = yield* onHost(loadEvictions(evictionPath(root))).pipe(Effect.orDie)
      expect(log.total).toBe(total)
      expect(log.evictions).toHaveLength(retainedEvictions)
    }),
  )

  it.effect('writes the eviction record only after the files are actually gone', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const segment = yield* openSegment(root, 'example/sloppenheimer#18', 1, 1_000)
      yield* onHost(appendTraceEvent(segment, event(1))).pipe(Effect.orDie)
      yield* onHost(
        pruneTraces(
          traceRoot(root),
          evictionPath(root),
          { ...limits, retentionMs: 1 },
          600_000,
          new Set(),
        ),
      ).pipe(Effect.orDie)
      const recorded = yield* Effect.promise(() => readFile(evictionPath(root), 'utf8'))
      expect(recorded).toContain('"total": 1')
      const remaining = yield* onHost(listSegments(traceRoot(root))).pipe(Effect.orDie)
      expect(remaining).toEqual([])
    }),
  )
})
