import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect, Fiber, Ref, Stream } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { workflowDefaults, type TraceConfig } from '@sloppenheimer/core/config/workflow.js'
import { issueId, issueIdentifier, type Issue } from '@sloppenheimer/core/domain/domain.js'
import type { TraceObservation } from '@sloppenheimer/core/domain/trace.js'
import { traceQuery } from '@sloppenheimer/core'
import type { TraceRecorder } from '@sloppenheimer/core'
import { openTraceStore, traceRecorder } from '@sloppenheimer/core/core/runtime/traces.js'
import { hostFileSystem } from '../harness/filesystem.js'

/**
 * The recorder as the running host uses it: one segment per run, one sequence per issue, and a
 * failure that never reaches the run it is about.
 *
 * These use the real store against a real directory, because what is under test is the part that
 * survives the process — the sequence a restart continues, the segment a retry opens beside the
 * one before it, and the two concurrent agents that must not interleave in one file.
 */

const directories: string[] = []

const makeRoot = (): Effect.Effect<string> =>
  Effect.promise(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppenheimer-recorder-'))
    directories.push(directory)
    return directory
  })

afterEach(async (): Promise<void> => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const enabled: TraceConfig = { enabled: true, limits: workflowDefaults.trace.limits }

const makeIssue = (number: number): Issue => ({
  id: issueId(String(number)),
  nativeRef: null,
  identifier: issueIdentifier(`example/sloppenheimer#${String(number)}`),
  title: `Issue ${String(number)}`,
  description: null,
  priority: null,
  state: 'open',
  branchName: null,
  url: null,
  assigneeId: null,
  labels: [],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
})

const message = (text: string): TraceObservation => ({
  category: 'message',
  outcome: 'succeeded',
  body: { kind: 'message', role: 'assistant', text },
  redacted: false,
  truncations: [],
})

const identity = { threadId: 't', turnId: 'u', sessionId: 't-u', turnCount: 1 }

/** A recorder bound to a directory, the way `runtime/context.ts` binds one to the workflow root. */
const makeRecorder = (root: string, trace: TraceConfig = enabled): Effect.Effect<TraceRecorder> =>
  Effect.provide(openTraceStore(trace), hostFileSystem).pipe(
    Effect.map((store) => traceRecorder(store, Effect.succeed(root))),
  )

describe('recording an agent trace', (): void => {
  it.effect('records what a run reported, in order', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const recorder = yield* makeRecorder(root)
      const issue = makeIssue(18)
      yield* recorder.openRun(issue, 1, 0)
      yield* recorder.lifecycle(issue.id, 'run_started', null)
      yield* recorder.record(issue.id, 'item/completed', message('first'), identity)
      yield* recorder.record(issue.id, 'item/completed', message('second'), identity)
      const page = yield* recorder.page(issue.identifier, traceQuery())
      expect(page.enabled).toBe(true)
      expect(page.events.map((event) => event.sequence)).toEqual([1, 2, 3])
      expect(page.events[0]?.category).toBe('lifecycle')
      expect(page.events[2]?.body).toEqual({ kind: 'message', role: 'assistant', text: 'second' })
    }),
  )

  it.effect('records nothing for an issue with no open run', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const recorder = yield* makeRecorder(root)
      const issue = makeIssue(18)
      yield* recorder.record(issue.id, 'item/completed', message('orphan'), identity)
      const page = yield* recorder.page(issue.identifier, traceQuery())
      expect(page.events).toEqual([])
    }),
  )

  it.effect('continues the sequence across a retry rather than restarting it', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const recorder = yield* makeRecorder(root)
      const issue = makeIssue(18)
      yield* recorder.openRun(issue, 1, 0)
      yield* recorder.record(issue.id, 'item/completed', message('attempt one'), identity)
      yield* recorder.openRun(issue, 2, 1)
      yield* recorder.record(issue.id, 'item/completed', message('attempt two'), identity)
      const page = yield* recorder.page(issue.identifier, traceQuery())
      expect(page.events.map((event) => event.sequence)).toEqual([1, 2])
      expect(page.events.map((event) => event.attempt)).toEqual([0, 1])
      expect(page.events.map((event) => event.runId)).toEqual([1, 2])
    }),
  )

  it.effect('continues the sequence across a restart, reading what the last host wrote', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const issue = makeIssue(18)
      const before = yield* makeRecorder(root)
      yield* before.openRun(issue, 1, 0)
      yield* before.record(issue.id, 'item/completed', message('before'), identity)
      yield* before.record(issue.id, 'item/completed', message('restart imminent'), identity)
      // A new store, as a restarted process would build: nothing in memory carries over.
      const after = yield* makeRecorder(root)
      yield* after.openRun(issue, 1, 1)
      yield* after.record(issue.id, 'item/completed', message('after'), identity)
      const page = yield* after.page(issue.identifier, traceQuery())
      expect(page.events.map((event) => event.sequence)).toEqual([1, 2, 3])
      expect(page.events.at(-1)?.body).toEqual({
        kind: 'message',
        role: 'assistant',
        text: 'after',
      })
    }),
  )

  it.effect('keeps two concurrent agents in segments and sequences of their own', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const recorder = yield* makeRecorder(root)
      const first = makeIssue(18)
      const second = makeIssue(19)
      yield* recorder.openRun(first, 1, 0)
      yield* recorder.openRun(second, 2, 0)
      const write = (issue: Issue, index: number): Effect.Effect<void> =>
        recorder.record(
          issue.id,
          'item/completed',
          message(`${issue.id}-${String(index)}`),
          identity,
        )
      yield* Effect.all(
        [...Array.from({ length: 10 }).keys()].flatMap((index) => [
          write(first, index),
          write(second, index),
        ]),
        { concurrency: 'unbounded' },
      )
      const firstPage = yield* recorder.page(first.identifier, traceQuery())
      const secondPage = yield* recorder.page(second.identifier, traceQuery())
      expect(firstPage.events).toHaveLength(10)
      expect(secondPage.events).toHaveLength(10)
      // Every record decoded, so no append landed inside another's line.
      expect(firstPage.malformedRecords).toBe(0)
      expect(secondPage.malformedRecords).toBe(0)
      expect(firstPage.events.map((event) => event.sequence).sort((a, b) => a - b)).toEqual(
        [...Array.from({ length: 10 }).keys()].map((index) => index + 1),
      )
      expect(firstPage.events.every((event) => event.identifier === first.identifier)).toBe(true)
    }),
  )

  it.effect('stops appending at the session ceiling and says so before it does', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const recorder = yield* makeRecorder(root, {
        enabled: true,
        limits: { ...workflowDefaults.trace.limits, sessionLimitBytes: 400 },
      })
      const issue = makeIssue(18)
      yield* recorder.openRun(issue, 1, 0)
      for (let index = 0; index < 20; index += 1) {
        yield* recorder.record(
          issue.id,
          'item/completed',
          message(`record ${String(index)}`),
          identity,
        )
      }
      const page = yield* recorder.page(issue.identifier, traceQuery())
      const last = page.events.at(-1)
      expect(last?.event).toBe('trace/limit_reached')
      expect(last?.body).toMatchObject({ kind: 'lifecycle', phase: 'trace_session_limit_reached' })
      // And nothing after it: the ceiling is a stop, not a filter.
      expect(page.events.filter((event) => event.event === 'trace/limit_reached')).toHaveLength(1)
      expect(page.limits.sessionLimitBytes).toBe(400)
    }),
  )
})

describe('reading a trace back', (): void => {
  const write = (root: string): Effect.Effect<TraceRecorder> =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder(root)
      const issue = makeIssue(18)
      yield* recorder.openRun(issue, 1, 0)
      yield* recorder.record(issue.id, 'a', message('one'), identity)
      yield* recorder.record(issue.id, 'b', message('two'), identity)
      yield* recorder.lifecycle(issue.id, 'run_ended', null)
      return recorder
    })

  it.effect('pages forward by sequence and says when there is more', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const recorder = yield* write(root)
      const identifier = makeIssue(18).identifier
      const first = yield* recorder.page(identifier, traceQuery({ limit: 2 }))
      expect(first.events.map((event) => event.sequence)).toEqual([1, 2])
      expect(first.hasMore).toBe(true)
      const second = yield* recorder.page(
        identifier,
        traceQuery({ limit: 2, after: first.nextAfter }),
      )
      expect(second.events.map((event) => event.sequence)).toEqual([3])
      expect(second.hasMore).toBe(false)
    }),
  )

  it.effect('filters by category without disturbing the sequence numbering', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const recorder = yield* write(root)
      const page = yield* recorder.page(
        makeIssue(18).identifier,
        traceQuery({ categories: ['lifecycle'] }),
      )
      expect(page.events).toHaveLength(1)
      expect(page.events[0]?.sequence).toBe(3)
    }),
  )

  it.effect('publishes the limits in force beside the records', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const recorder = yield* write(root)
      const page = yield* recorder.page(makeIssue(18).identifier, traceQuery())
      expect(page.limits).toEqual(workflowDefaults.trace.limits)
      expect(page.evictionsTotal).toBe(0)
    }),
  )

  it.effect('delivers records to a live subscriber as they are written', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const recorder = yield* makeRecorder(root)
      const issue = makeIssue(18)
      yield* recorder.openRun(issue, 1, 0)
      const seen = yield* Ref.make<readonly number[]>([])
      const subscriber = yield* Effect.fork(
        Stream.runForEach(recorder.live(issue.identifier), (event) =>
          Ref.update(seen, (held) => [...held, event.sequence]),
        ),
      )
      // The subscription is established by the fork above; a record written after it must arrive.
      yield* Effect.yieldNow()
      yield* recorder.record(issue.id, 'item/completed', message('live'), identity)
      yield* Effect.yieldNow()
      yield* Fiber.interrupt(subscriber)
      expect(yield* Ref.get(seen)).toEqual([1])
    }),
  )
})

describe('with high-fidelity capture switched off', (): void => {
  it.effect('writes nothing at all and says the trace is disabled', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const recorder = yield* makeRecorder(root, workflowDefaults.trace)
      const issue = makeIssue(18)
      expect(recorder.capture.enabled).toBe(false)
      yield* recorder.openRun(issue, 1, 0)
      yield* recorder.record(issue.id, 'item/completed', message('ignored'), identity)
      const page = yield* recorder.page(issue.identifier, traceQuery())
      expect(page.enabled).toBe(false)
      expect(page.events).toEqual([])
      // Nothing on disk either: retention with capture off has nothing to retain.
      const directory = yield* Effect.promise(async () =>
        rm(join(root, '.sloppenheimer', 'traces'), { recursive: true }).then(
          () => 'present',
          () => 'absent',
        ),
      )
      expect(directory).toBe('absent')
    }),
  )
})
