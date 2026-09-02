import type { FileSystem } from '@effect/platform'
import type { Effect, PubSub, Ref, Stream } from 'effect'

import type { Issue, IssueId } from '../../domain/domain.js'
import type {
  TraceCapture,
  TraceCategory,
  TraceEvent,
  TraceEviction,
  TraceLimits,
  TraceObservation,
  TraceOutcome,
} from '../../domain/trace.js'
import type { TraceSegment } from '../trace-store.js'

/**
 * The durable trace's cell and wire types.
 *
 * They sit in a module of their own rather than in `runtime/types.ts` because they are a
 * self-contained vocabulary — nothing else in the runtime reads them — and because folding them in
 * would push that module past the 500-line limit the repository enforces on every source file.
 */

/** The session identity a trace record is attributed to. */
export type TraceIdentity = Readonly<{
  threadId: string | null
  turnId: string | null
  sessionId: string | null
  turnCount: number
}>

/** One live run's trace bookkeeping: where it writes, how much it has spent, and where it is up to. */
export type TraceOpenRun = Readonly<{
  identifier: string
  runId: number
  attempt: number
  segment: TraceSegment
  /** The last sequence written for this issue, continued across runs and across restarts. */
  sequence: number
  bytes: number
  /** Whether this segment reached its ceiling and stopped, which it reported before it did. */
  limitReached: boolean
}>

/**
 * The trace store as the runtime holds it: the configuration in force, the bookkeeping for the
 * runs writing right now, the semaphore that keeps one append whole, and the live tail.
 *
 * It sits beside `RuntimeStores` rather than inside `RuntimeState` on purpose — see
 * `runtime/traces.ts` for why a trace is deliberately not part of the value every reader copies.
 */
export type TraceStore = Readonly<{
  enabled: boolean
  limits: TraceLimits
  /** What a launch hands a runner, so a session captures at exactly the fidelity configured. */
  capture: TraceCapture
  open: Ref.Ref<ReadonlyMap<IssueId, TraceOpenRun>>
  writes: Effect.Semaphore
  live: PubSub.PubSub<TraceEvent>
  onHostFileSystem: <Value, Error>(
    effect: Effect.Effect<Value, Error, FileSystem.FileSystem>,
  ) => Effect.Effect<Value, Error>
}>

/** What a page asks for. Every filter is `null` for "no filter" rather than an empty list. */
export type TraceQuery = Readonly<{
  /** Return records after this sequence. `0` starts at the beginning of retained history. */
  after: number
  limit: number
  categories: readonly TraceCategory[] | null
  outcomes: readonly TraceOutcome[] | null
  attempt: number | null
  turnId: string | null
}>

/**
 * One page, and everything an operator needs to read a gap in it correctly: the limits that cut a
 * field, the evictions that removed a segment, and the records a torn write left unreadable.
 */
export type TracePage = Readonly<{
  /** Whether high-fidelity capture is on at all. Off means no history exists, not none matched. */
  enabled: boolean
  identifier: string
  events: readonly TraceEvent[]
  /** The sequence to pass as the next request's `after`. */
  nextAfter: number
  hasMore: boolean
  malformedRecords: number
  limits: TraceLimits
  evictions: readonly TraceEviction[]
  /** How many evictions this host has recorded in total, since the list itself is bounded. */
  evictionsTotal: number
}>

/** The durable trace's operations, bound to the store and the workspace root in force. */
export type TraceRecorder = Readonly<{
  enabled: boolean
  limits: TraceLimits
  capture: TraceCapture
  /** Opens the segment a dispatched run appends to, and runs the retention pass. */
  openRun: (issue: Issue, runId: number, attempt: number) => Effect.Effect<void>
  /** A run beginning or ending, as the host sees it rather than as the runner reports it. */
  lifecycle: (issueId: IssueId, phase: string, detail: string | null) => Effect.Effect<void>
  closeRun: (issueId: IssueId) => Effect.Effect<void>
  record: (
    issueId: IssueId,
    event: string,
    observation: TraceObservation,
    identity: TraceIdentity,
  ) => Effect.Effect<void>
  page: (identifier: string, query: TraceQuery) => Effect.Effect<TracePage>
  live: (identifier: string) => Stream.Stream<TraceEvent>
}>
