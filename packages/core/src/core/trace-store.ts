import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { dirname, join, resolve } from 'node:path'
import { Effect, Schema } from 'effect'

import type { IssueIdentifier } from '../domain/domain.js'
import { TraceStoreError } from '../domain/errors.js'
import { traceCategories, traceOutcomes, type TraceEvent } from '../domain/trace.js'
import { containedWorkspacePath, workspaceKey } from '../domain/workspace-containment.js'
import { isJsonValue } from '../support/json.js'

/**
 * Where a durable agent trace lives on disk, and how one record reaches it.
 *
 * The two existing stores are versioned JSON documents rewritten whole (`core/json-store.ts`),
 * which is right for a small set of live facts and wrong for a trace: rewriting the document to add
 * an event would make the cost of an event grow with the session, and an interrupted rewrite would
 * lose everything that had gone before it. So a trace is **append-only JSON Lines**, one segment
 * per run:
 *
 * - Appending is one write of one line, so an interrupted write can damage only the line it was
 *   writing. Every record before it is already on disk and untouched, which is the whole of what
 *   "interrupted writes cannot corrupt earlier trace records" asks for. A torn final line is
 *   detected on read and counted rather than failing the page that found it.
 * - A segment is named `<startedAt>-<runId>.jsonl` under a directory named for the issue, so the
 *   retention pass can order and age every segment from its name alone — no clock comparison
 *   against a mtime another host wrote, and no read of a file it is about to delete.
 * - Both path segments are derived through `workspaceKey` and re-checked with
 *   `containedWorkspacePath`, the same containment the workspace manager uses. An identifier is a
 *   tracker's spelling and reaches this host from an agent-editable place; it never becomes a path
 *   this host did not construct.
 *
 * The trace root sits under the host's own `.sloppenheimer/` directory beside the handoff and
 * completion stores — inside the configured host data boundary, and never inside an agent worktree.
 */

/** The directory every trace segment lives under, relative to the workspace root in force. */
export const traceDirectoryName = 'traces'

/** Where every trace segment lives, under the workspace root in force at the moment of writing. */
export const traceRoot = (workspaceRoot: string): string =>
  resolve(workspaceRoot, '.sloppenheimer', traceDirectoryName)

/** The record of evictions sits beside the segments it names. */
export const evictionPath = (workspaceRoot: string): string =>
  join(traceRoot(workspaceRoot), 'evictions.json')

/** One run's trace, as its file name states it. */
export type TraceSegment = Readonly<{
  identifierKey: string
  fileName: string
  path: string
  runId: number
  startedAtMs: number
}>

const nullableString = Schema.NullOr(Schema.String)
const nullableNumber = Schema.NullOr(Schema.Number)
const jsonValue = Schema.declare(isJsonValue)

const truncation = Schema.Struct({
  field: Schema.String,
  reason: Schema.Literal('byte_limit', 'depth_limit', 'count_limit'),
  retainedBytes: Schema.Number,
  originalBytes: nullableNumber,
})

const fileChange = Schema.Struct({
  path: Schema.String,
  change: Schema.Literal('add', 'update', 'delete', 'unknown'),
  addedLines: nullableNumber,
  deletedLines: nullableNumber,
  patch: nullableString,
})

const traceField = Schema.Struct({
  name: Schema.String,
  type: Schema.Literal('string', 'number', 'boolean', 'null', 'object', 'array'),
  value: nullableString,
  bytes: Schema.Number,
})

const traceBody = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('lifecycle'),
    phase: Schema.String,
    detail: nullableString,
  }),
  Schema.Struct({
    kind: Schema.Literal('message'),
    role: Schema.Literal('assistant', 'user'),
    text: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('reasoning_summary'), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('command'),
    commandLine: Schema.String,
    stdout: nullableString,
    stderr: nullableString,
    exitCode: nullableNumber,
    durationMs: nullableNumber,
  }),
  Schema.Struct({
    kind: Schema.Literal('tool'),
    name: Schema.String,
    arguments: Schema.NullOr(jsonValue),
    result: Schema.NullOr(jsonValue),
    durationMs: nullableNumber,
  }),
  Schema.Struct({ kind: Schema.Literal('file'), files: Schema.Array(fileChange) }),
  Schema.Struct({
    kind: Schema.Literal('approval'),
    subject: Schema.String,
    decision: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('usage'),
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    totalTokens: Schema.Number,
    rateLimits: Schema.NullOr(jsonValue),
  }),
  Schema.Struct({
    kind: Schema.Literal('retry'),
    attempt: Schema.Number,
    dueAt: nullableString,
    reason: nullableString,
  }),
  Schema.Struct({ kind: Schema.Literal('cancellation'), reason: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('handoff'),
    step: Schema.String,
    status: Schema.String,
    message: nullableString,
  }),
  Schema.Struct({
    kind: Schema.Literal('error'),
    severity: Schema.Literal('warning', 'error'),
    code: nullableString,
    message: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('unknown'), fields: Schema.Array(traceField) }),
)

/**
 * The decoded form of one persisted line.
 *
 * Tolerance is deliberately *not* used here: this is a format Sloppenheimer defines and writes, so a
 * record that does not decode is a bug in this host's writer or a line an interruption tore, and
 * both are worth counting rather than papering over. What the reader does with a rejected line is
 * skip it and report it, which is a different thing from accepting it half-read.
 */
const traceRecord: Schema.Schema<TraceEvent> = Schema.Struct({
  version: Schema.Literal(1),
  sequence: Schema.Number,
  recordedAt: Schema.String,
  issueId: Schema.String,
  identifier: Schema.String,
  runId: Schema.Number,
  attempt: Schema.Number,
  threadId: nullableString,
  turnId: nullableString,
  sessionId: nullableString,
  turnCount: Schema.Number,
  event: Schema.String,
  category: Schema.Literal(...traceCategories),
  outcome: Schema.Literal(...traceOutcomes),
  body: traceBody,
  redacted: Schema.Boolean,
  truncations: Schema.Array(truncation),
})

const decodeRecord = Schema.decodeUnknownEither(traceRecord)

const failure = (
  operation: 'read' | 'write' | 'prune',
  message: string,
  cause?: unknown,
): TraceStoreError => new TraceStoreError({ operation, message, cause })

const platformFailure =
  (operation: 'read' | 'write' | 'prune', what: string) =>
  (error: PlatformError): TraceStoreError =>
    failure(
      operation,
      `Could not ${operation} ${what}${error.description === undefined ? '' : `: ${error.description}`}`,
      error,
    )

/**
 * The file one run appends to, with both path segments checked for containment.
 *
 * The instant is part of the name rather than of the directory so that a retention pass reading the
 * directory can order segments without opening any of them, and the run id is part of it so two
 * runs started in the same millisecond cannot collide on one name.
 */
export const segmentPath = (
  traceRoot: string,
  identifier: IssueIdentifier,
  runId: number,
  startedAtMs: number,
): Effect.Effect<TraceSegment, TraceStoreError> => {
  const identifierKey = workspaceKey(identifier)
  const fileName = `${String(startedAtMs).padStart(14, '0')}-${String(runId)}.jsonl`
  return containedWorkspacePath(traceRoot, identifierKey).pipe(
    Effect.flatMap((issueDirectory) =>
      containedWorkspacePath(issueDirectory, fileName).pipe(
        Effect.map((path): TraceSegment => ({ identifierKey, fileName, path, runId, startedAtMs })),
      ),
    ),
    Effect.mapError((error) =>
      failure('write', `trace path for ${identifier} is not contained: ${error.message}`, error),
    ),
  )
}

/** The instant and run a segment file name states, or `null` when the name is not one of ours. */
export const parseSegmentName = (
  fileName: string,
): Readonly<{ runId: number; startedAtMs: number }> | null => {
  const match = /^(\d{14})-(\d+)\.jsonl$/u.exec(fileName)
  if (match?.[1] === undefined || match[2] === undefined) {
    return null
  }
  return { startedAtMs: Number(match[1]), runId: Number(match[2]) }
}

/**
 * Every segment this host has written, oldest first.
 *
 * A directory entry that is not a segment name is ignored rather than reported: the trace root is
 * this host's own directory, but it is still a directory, and a stray file is not a reason to stop
 * retaining traces.
 */
export const listSegments = (
  traceRoot: string,
): Effect.Effect<readonly TraceSegment[], TraceStoreError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const present = yield* fileSystem
      .exists(traceRoot)
      .pipe(Effect.mapError(platformFailure('read', `trace directory ${traceRoot}`)))
    if (!present) {
      return []
    }
    const identifierKeys = yield* fileSystem
      .readDirectory(traceRoot)
      .pipe(Effect.mapError(platformFailure('read', `trace directory ${traceRoot}`)))
    const segments: TraceSegment[] = []
    for (const identifierKey of identifierKeys) {
      const issueDirectory = yield* containedWorkspacePath(traceRoot, identifierKey).pipe(
        Effect.mapError(() => failure('read', `trace entry ${identifierKey} is not contained`)),
      )
      const info = yield* fileSystem
        .stat(issueDirectory)
        .pipe(Effect.mapError(platformFailure('read', `trace entry ${identifierKey}`)))
      if (info.type !== 'Directory') {
        continue
      }
      const files = yield* fileSystem
        .readDirectory(issueDirectory)
        .pipe(Effect.mapError(platformFailure('read', `trace directory ${issueDirectory}`)))
      for (const fileName of files) {
        const named = parseSegmentName(fileName)
        if (named === null) {
          continue
        }
        segments.push({
          identifierKey,
          fileName,
          path: join(issueDirectory, fileName),
          runId: named.runId,
          startedAtMs: named.startedAtMs,
        })
      }
    }
    return segments.sort(
      (left, right) =>
        left.startedAtMs - right.startedAtMs ||
        left.runId - right.runId ||
        left.identifierKey.localeCompare(right.identifierKey),
    )
  })

/** How many bytes a segment holds, or `0` for one that no longer exists. */
export const segmentBytes = (
  path: string,
): Effect.Effect<number, TraceStoreError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.stat(path)),
    Effect.map((info) => Number(info.size)),
    Effect.catchAll((error) =>
      error._tag === 'SystemError' && error.reason === 'NotFound'
        ? Effect.succeed(0)
        : Effect.fail(platformFailure('read', `trace segment ${path}`)(error)),
    ),
  )

/**
 * Appends one record, answering with how many bytes it added.
 *
 * The line is serialized before the directory is created, so a record that cannot be rendered
 * fails without leaving an empty directory behind. Mode `0o600` matches the other stores: a trace
 * is the most sensitive document this host writes.
 */
export const appendTraceEvent = (
  segment: TraceSegment,
  event: TraceEvent,
): Effect.Effect<number, TraceStoreError, FileSystem.FileSystem> =>
  Effect.try({
    try: () => `${JSON.stringify(event)}\n`,
    catch: (cause: unknown) => failure('write', 'trace event could not be serialized', cause),
  }).pipe(
    Effect.flatMap((line) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          fileSystem
            .makeDirectory(dirname(segment.path), { recursive: true })
            .pipe(
              Effect.zipRight(
                fileSystem.writeFileString(segment.path, line, { flag: 'a', mode: 0o600 }),
              ),
            ),
        ),
        Effect.mapError(platformFailure('write', `trace segment ${segment.path}`)),
        Effect.as(Buffer.byteLength(line, 'utf8')),
      ),
    ),
  )

/** What one segment held: the records that decoded, and how many lines did not. */
export type SegmentContents = Readonly<{
  events: readonly TraceEvent[]
  /** Lines that were present and unreadable — a torn tail, or a record this host cannot decode. */
  malformed: number
}>

/**
 * Reads one segment.
 *
 * A line that does not decode is counted and skipped, never fatal. The one an interrupted write
 * tore is always the last, but nothing here depends on that: a reader that stopped at the first bad
 * line would hide however many good records followed it.
 */
export const readSegment = (
  path: string,
): Effect.Effect<SegmentContents, TraceStoreError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path, 'utf8')),
    Effect.catchAll((error) =>
      error._tag === 'SystemError' && error.reason === 'NotFound'
        ? Effect.succeed('')
        : Effect.fail(platformFailure('read', `trace segment ${path}`)(error)),
    ),
    Effect.map((contents) => {
      const events: TraceEvent[] = []
      let malformed = 0
      for (const line of contents.split('\n')) {
        if (line.trim().length === 0) {
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          malformed += 1
          continue
        }
        const decoded = decodeRecord(parsed)
        if (decoded._tag === 'Left') {
          malformed += 1
          continue
        }
        events.push(decoded.right)
      }
      return { events, malformed }
    }),
  )

/** Deletes one segment, treating a segment already gone as deleted. */
export const removeSegment = (
  path: string,
): Effect.Effect<void, TraceStoreError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.remove(path, { force: true })),
    Effect.mapError(platformFailure('prune', `trace segment ${path}`)),
  )
