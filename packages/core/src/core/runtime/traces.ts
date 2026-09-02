import { FileSystem } from '@effect/platform'
import { Clock, Effect, PubSub, Ref, Stream } from 'effect'

import type { Issue, IssueId } from '../../domain/domain.js'
import type { TraceStoreError } from '../../domain/errors.js'
import {
  traceCaptureDisabled,
  type TraceEvent,
  type TraceEviction,
  type TraceObservation,
} from '../../domain/trace.js'
import { logWarning } from '../../support/logging.js'
import { pruneTraces } from '../trace-retention.js'
import {
  appendTraceEvent,
  evictionPath,
  listSegments,
  readSegment,
  segmentPath,
  traceRoot,
  type TraceSegment,
} from '../trace-store.js'
import type { EffectiveWorkflow } from '../state.js'
import { readTracePage } from './trace-reader.js'
import type { TraceIdentity, TraceOpenRun, TraceRecorder, TraceStore } from './trace-types.js'

/**
 * The durable trace as the running host writes and reads it.
 *
 * The store's state is deliberately *not* part of `RuntimeState`. The whole point of the trace is
 * that it is unbounded where the snapshot is bounded, and putting a session's worth of complete
 * messages into the value every reader copies would undo the retention the snapshot exists to
 * promise. What the store keeps in memory is one small record per live run — where its segment is,
 * how many bytes it has spent, and the next sequence number — and everything else is on disk.
 *
 * Three properties are load-bearing:
 *
 * - **A trace never disturbs a run.** Every failure here is logged and dropped. A trace is evidence
 *   about work, never part of it, and a disk that filled must not fail the agent that filled it.
 * - **Sequence is monotonic per issue, across runs and across restarts.** A run that opens a
 *   segment reads the last sequence this host wrote for that issue, so a restart continues the
 *   numbering rather than replaying it. That is what makes "reconstructable in order" true of a
 *   host that was restarted in the middle.
 * - **Appends are serialized.** One semaphore covers every append, so two concurrent agents cannot
 *   interleave halves of two lines in one file — and, because each of them writes to its own
 *   segment, they never contend for long.
 */

/**
 * Binds the trace store to the workflow the orchestrator adopted.
 *
 * The filesystem is bound once, as it is for the other two stores: the runtime hands its own
 * operations out as effects for a callback to run, and those carry no context of their own.
 */
export const openTraceStore = (
  bootstrap: EffectiveWorkflow,
): Effect.Effect<TraceStore, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const trace = bootstrap.workflow.config.trace
    return {
      enabled: trace.enabled,
      limits: trace.limits,
      capture: trace.enabled
        ? {
            enabled: true,
            fieldLimitBytes: trace.limits.fieldLimitBytes,
            eventLimitBytes: trace.limits.eventLimitBytes,
          }
        : traceCaptureDisabled,
      open: yield* Ref.make<ReadonlyMap<IssueId, TraceOpenRun>>(new Map()),
      writes: yield* Effect.makeSemaphore(1),
      // Bounded: a console that stopped reading must not hold the writer up, and a dropped live
      // event is still on disk for the page that follows it.
      live: yield* PubSub.dropping<TraceEvent>(256),
      onHostFileSystem: (effect) =>
        Effect.provideService(effect, FileSystem.FileSystem, fileSystem),
    }
  })

/** A trace failure is reported and dropped: it is evidence about a run, never part of one. */
const dropped = <Value>(
  store: TraceStore,
  action: string,
  effect: Effect.Effect<Value, TraceStoreError, FileSystem.FileSystem>,
  fallback: Value,
): Effect.Effect<Value> =>
  store.onHostFileSystem(effect).pipe(
    Effect.catchAll((error) =>
      logWarning('agent trace operation failed', {
        action,
        outcome: 'failed',
        operation: error.operation,
        error: error.message,
      }).pipe(Effect.as(fallback)),
    ),
  )

/** The highest sequence this host has already written for an issue, or `0` for a new one. */
const lastSequence = (
  store: TraceStore,
  root: string,
  identifierKey: string,
): Effect.Effect<number> =>
  dropped(
    store,
    'agent_trace_resume',
    listSegments(root).pipe(
      Effect.flatMap((segments) => {
        const owned = segments.filter((segment) => segment.identifierKey === identifierKey)
        const newest = owned.at(-1)
        return newest === undefined
          ? Effect.succeed(0)
          : readSegment(newest.path).pipe(Effect.map(({ events }) => events.at(-1)?.sequence ?? 0))
      }),
    ),
    0,
  )

/**
 * Opens the segment one dispatched run appends to, and runs the retention pass.
 *
 * Pruning happens here rather than on a timer because this is the moment the trace is about to
 * grow, and because a host that dispatches nothing should not be deleting anything. The segment
 * just opened is excluded from the pass by construction — it is in `open` before the pass reads the
 * directory.
 */
export const openTraceRun = (
  store: TraceStore,
  workspaceRoot: string,
  issue: Issue,
  runId: number,
  attempt: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!store.enabled) {
      return
    }
    const root = traceRoot(workspaceRoot)
    const startedAtMs = yield* Clock.currentTimeMillis
    const segment = yield* dropped<TraceSegment | null>(
      store,
      'agent_trace_open',
      segmentPath(root, issue.identifier, runId, startedAtMs),
      null,
    )
    if (segment === null) {
      return
    }
    const sequence = yield* lastSequence(store, root, segment.identifierKey)
    yield* Ref.update(store.open, (current) => {
      const next = new Map(current)
      next.set(issue.id, {
        identifier: issue.identifier,
        runId,
        attempt,
        segment,
        sequence,
        bytes: 0,
        limitReached: false,
      })
      return next
    })
    const active = yield* Ref.get(store.open)
    yield* dropped<readonly TraceEviction[]>(
      store,
      'agent_trace_prune',
      pruneTraces(
        root,
        evictionPath(workspaceRoot),
        store.limits,
        startedAtMs,
        new Set([...active.values()].map((entry) => entry.segment.path)),
      ),
      [],
    )
  })

/** Forgets a run's segment. The file stays; only the in-memory bookkeeping goes. */
export const closeTraceRun = (store: TraceStore, issueId: IssueId): Effect.Effect<void> =>
  Ref.update(store.open, (current) => {
    if (!current.has(issueId)) {
      return current
    }
    const next = new Map(current)
    next.delete(issueId)
    return next
  })

/**
 * The event a run's next record becomes, and the bookkeeping it advances — as one atomic step, so
 * two concurrent reports can never be handed the same sequence number.
 *
 * A run whose segment has spent its byte ceiling answers `null` and records that it did so exactly
 * once: the ceiling is reported as a trace event of its own, and then the segment goes quiet.
 */
const nextTraceEvent = (
  store: TraceStore,
  issueId: IssueId,
  identity: TraceIdentity,
  event: string,
  observation: TraceObservation,
  recordedAt: string,
): Effect.Effect<Readonly<{ segment: TraceSegment; event: TraceEvent }> | null> =>
  Ref.modify(store.open, (current) => {
    const open = current.get(issueId)
    if (open === undefined || open.limitReached) {
      return [null, current]
    }
    const overLimit = open.bytes >= store.limits.sessionLimitBytes
    const sequence = open.sequence + 1
    const body: TraceObservation = overLimit
      ? {
          category: 'lifecycle',
          outcome: 'informational',
          body: {
            kind: 'lifecycle',
            phase: 'trace_session_limit_reached',
            detail: `the segment reached its ${String(store.limits.sessionLimitBytes)} byte ceiling; later events for this run are not retained`,
          },
          redacted: false,
          truncations: [],
        }
      : observation
    const traceEvent: TraceEvent = {
      version: 1,
      sequence,
      recordedAt,
      issueId,
      identifier: open.identifier,
      runId: open.runId,
      attempt: open.attempt,
      threadId: identity.threadId,
      turnId: identity.turnId,
      sessionId: identity.sessionId,
      turnCount: identity.turnCount,
      event: overLimit ? 'trace/limit_reached' : event,
      category: body.category,
      outcome: body.outcome,
      body: body.body,
      redacted: body.redacted,
      truncations: body.truncations,
    }
    const next = new Map(current)
    next.set(issueId, { ...open, sequence, limitReached: overLimit })
    return [{ segment: open.segment, event: traceEvent }, next]
  })

/**
 * Records one observation against the run the issue is on.
 *
 * The whole append is inside one semaphore permit, so a line is written whole. Nothing is recorded
 * for an issue with no open run: output from a worker the orchestrator has already ended belongs to
 * no attempt, which is the same rule the bounded timeline follows.
 */
export const recordTrace = (
  store: TraceStore,
  issueId: IssueId,
  event: string,
  observation: TraceObservation,
  identity: TraceIdentity,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!store.enabled) {
      return
    }
    const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const next = yield* nextTraceEvent(store, issueId, identity, event, observation, recordedAt)
    if (next === null) {
      return
    }
    const written = yield* store.writes.withPermits(1)(
      dropped(store, 'agent_trace_append', appendTraceEvent(next.segment, next.event), 0),
    )
    yield* Ref.update(store.open, (current) => {
      const open = current.get(issueId)
      if (open === undefined) {
        return current
      }
      const updated = new Map(current)
      updated.set(issueId, { ...open, bytes: open.bytes + written })
      return updated
    })
    yield* PubSub.publish(store.live, next.event)
  })

/** Live records for one issue, from the moment the subscriber attaches. */
export const traceStream = (store: TraceStore, identifier: string): Stream.Stream<TraceEvent> =>
  Stream.filter(Stream.fromPubSub(store.live), (event) => event.identifier === identifier)

/**
 * The recorder as one record of operations, bound to the store the runtime opened and to the
 * workspace root in force.
 *
 * The root is an effect rather than a value for the reason the other two stores give: a reload may
 * move `workspaceRoot`, and a segment written beside a root the host has left is one the next
 * startup would read nothing from.
 */
export const traceRecorder = (
  store: TraceStore,
  workspaceRootOf: Effect.Effect<string>,
): TraceRecorder => ({
  enabled: store.enabled,
  limits: store.limits,
  capture: store.capture,
  openRun: (issue, runId, attempt) =>
    workspaceRootOf.pipe(
      Effect.flatMap((root) => openTraceRun(store, root, issue, runId, attempt)),
    ),
  lifecycle: (issueId, phase, detail) => traceRunLifecycle(store, issueId, phase, detail),
  closeRun: (issueId) => closeTraceRun(store, issueId),
  record: (issueId, event, observation, identity) =>
    recordTrace(store, issueId, event, observation, identity),
  page: (identifier, query) =>
    workspaceRootOf.pipe(Effect.flatMap((root) => readTracePage(store, root, identifier, query))),
  live: (identifier) => traceStream(store, identifier),
})

/**
 * The identity a host-side observation carries.
 *
 * A retry, a cancellation and a handoff are the host's own facts about a run rather than messages
 * on the agent protocol, so they name no thread and no turn. They are still trace records, and in
 * the same sequence as everything else, because "what happened to this issue, in order" is the
 * question the trace exists to answer and half an answer is not one.
 */
export const hostTraceIdentity: TraceIdentity = Object.freeze({
  threadId: null,
  turnId: null,
  sessionId: null,
  turnCount: 0,
})

const hostObservation = (
  category: TraceObservation['category'],
  outcome: TraceObservation['outcome'],
  body: TraceObservation['body'],
): TraceObservation => ({ category, outcome, body, redacted: false, truncations: [] })

/** A run beginning or ending, as the host sees it rather than as the runner reports it. */
export const traceRunLifecycle = (
  store: TraceStore,
  issueId: IssueId,
  phase: string,
  detail: string | null,
): Effect.Effect<void> =>
  recordTrace(
    store,
    issueId,
    `host/${phase}`,
    hostObservation('lifecycle', 'informational', { kind: 'lifecycle', phase, detail }),
    hostTraceIdentity,
  )

export const traceRetryScheduled = (
  store: TraceStore,
  issueId: IssueId,
  attempt: number,
  dueAt: string,
  reason: string | null,
): Effect.Effect<void> =>
  recordTrace(
    store,
    issueId,
    'host/retry_scheduled',
    hostObservation('retry', 'started', { kind: 'retry', attempt, dueAt, reason }),
    hostTraceIdentity,
  )

export const traceCancellation = (
  store: TraceStore,
  issueId: IssueId,
  reason: string,
): Effect.Effect<void> =>
  recordTrace(
    store,
    issueId,
    'host/cancelled',
    hostObservation('cancellation', 'cancelled', { kind: 'cancellation', reason }),
    hostTraceIdentity,
  )

export const traceHandoff = (
  store: TraceStore,
  issueId: IssueId,
  step: string,
  status: string,
  message: string | null,
): Effect.Effect<void> =>
  recordTrace(
    store,
    issueId,
    'host/handoff',
    hostObservation('handoff', status === 'failed' ? 'failed' : 'succeeded', {
      kind: 'handoff',
      step,
      status,
      message,
    }),
    hostTraceIdentity,
  )
