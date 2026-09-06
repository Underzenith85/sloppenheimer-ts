import { it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Option, Ref, TestClock } from 'effect'
import { describe, expect } from 'vitest'

import { makeDurableHost } from '@sloppenheimer/core/core/durable/live-journal.js'
import { migratedHandoff } from '@sloppenheimer/core/core/durable/handoff-records.js'
import type { DurableWorkflow } from '@sloppenheimer/core/domain/durable-workflow.js'
import type { WorkflowStorePort } from '@sloppenheimer/core/ports/workflow-store.js'
import { WorkflowStoreError, WorkspaceError } from '@sloppenheimer/core/domain/errors.js'

const handoff = {
  issueId: '42',
  identifier: 'example/project#42',
  pullRequestUrl: 'https://github.test/pull/42',
  branchName: 'work',
  state: 'awaiting_checks' as const,
  headSha: 'head',
  reason: null,
  repairAttempts: 1,
  observedAt: new Date(0).toISOString(),
}

const memoryStore = Effect.gen(function* () {
  const records = yield* Ref.make<ReadonlyMap<string, DurableWorkflow>>(new Map())
  const store: WorkflowStorePort = {
    list: Ref.get(records).pipe(Effect.map((values) => [...values.values()])),
    get: (id) => Ref.get(records).pipe(Effect.map((values) => Option.fromNullable(values.get(id)))),
    commit: (record, expected) =>
      Ref.modify(records, (values) => {
        if ((values.get(record.issueId)?.revision ?? null) !== expected) {
          return [false, values]
        }
        return [true, new Map([...values, [record.issueId, record]])]
      }).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Effect.fail(
                new WorkflowStoreError({
                  category: 'conflict',
                  message: 'revision changed',
                }),
              ),
        ),
      ),
  }
  return store
})

describe('durable review commands', () => {
  it.effect(
    'retries captured cleanup after restart without needing the deleted tracker issue',
    () =>
      Effect.gen(function* () {
        const store = yield* memoryStore
        const initial: DurableWorkflow = {
          ...migratedHandoff(handoff, 0),
          status: { _tag: 'Completed', headSha: 'head' },
          artifact: {
            id: 'old',
            workspaceKey: 'old',
            workspacePath: '/original/root/issue/old',
            baselineSha: 'base',
            candidateRevision: 'tree',
            expectedRemoteHead: null,
            verifiedRevision: 'tree',
            publishedHead: 'head',
          },
        }
        yield* store.commit(initial, null)
        const host = yield* makeDurableHost(store)
        yield* host.queueCleanup('42')
        const failing = yield* host
          .cleanup('42', {
            removeCaptured: () =>
              Effect.fail(new WorkspaceError({ category: 'remove_failed', message: 'busy' })),
          })
          .pipe(Effect.fork)
        while ((yield* host.snapshot)[0]?.cleanup?.state !== 'retry') {
          yield* Effect.yieldNow()
        }
        yield* Fiber.interrupt(failing)
        const restarted = yield* makeDurableHost(store)
        const paths: string[] = []
        const retry = yield* restarted
          .cleanup('42', {
            removeCaptured: (workspace) =>
              Effect.sync(() => {
                paths.push(workspace.path)
              }),
          })
          .pipe(Effect.fork)
        yield* TestClock.adjust('10 seconds')
        yield* Fiber.join(retry)
        expect(paths).toEqual(['/original/root/issue/old'])
        expect((yield* restarted.snapshot)[0]?.cleanup).toMatchObject({
          state: 'completed',
          attempts: 2,
        })
      }),
  )
  it.effect(
    'migrates historical completion without inventing a merged SHA and keeps it on restart',
    () =>
      Effect.gen(function* () {
        const store = yield* memoryStore
        const host = yield* makeDurableHost(store)
        const completion = {
          issueId: '99',
          identifier: 'example/project#99',
          title: 'Previously merged',
          url: null,
          outcome: 'merged' as const,
          finishedAt: new Date(0).toISOString(),
          pullRequestUrl: null,
        }
        yield* host.recordCompletions([completion])
        const first = yield* host.snapshot
        yield* host.recordCompletions([completion])
        expect(yield* host.snapshot).toEqual(first)
        expect(first[0]).toMatchObject({
          status: { _tag: 'Completed', headSha: null },
          artifact: null,
        })
        const restarted = yield* makeDurableHost(store)
        expect((yield* restarted.snapshot)[0]?.completion).toEqual(completion)
      }),
  )

  it.effect('keeps a migrated review wait and its exact head across restart', () =>
    Effect.gen(function* () {
      const store = yield* memoryStore
      const host = yield* makeDurableHost(store)
      yield* host.recordHandoffs([handoff])
      const restarted = yield* makeDurableHost(store)
      expect((yield* restarted.snapshot)[0]).toMatchObject({
        status: { _tag: 'Waiting', condition: 'review' },
        handoff,
      })
      yield* restarted.recordHandoffs([{ ...handoff, state: 'merged' }])
      expect((yield* restarted.snapshot)[0]?.status).toEqual({ _tag: 'Completed', headSha: 'head' })
    }),
  )

  it.effect('expires external waits without spending another coding attempt', () =>
    Effect.gen(function* () {
      const store = yield* memoryStore
      const host = yield* makeDurableHost(store)
      yield* host.recordHandoffs([handoff])
      yield* TestClock.adjust('25 hours')
      yield* host.expireWaits
      expect((yield* host.snapshot)[0]).toMatchObject({
        status: { _tag: 'Intervention' },
        codingAttempts: 0,
      })
      let wrote = false
      yield* host
        .external(
          '42',
          'request_review',
          'head',
          Effect.sync(() => {
            wrote = true
          }),
        )
        .pipe(Effect.either)
      expect(wrote).toBe(false)
    }),
  )

  it.effect('imports legacy evidence once without inventing candidate verification', () =>
    Effect.gen(function* () {
      const store = yield* memoryStore
      const host = yield* makeDurableHost(store)
      yield* host.recordHandoffs([handoff])
      const first = yield* host.snapshot
      yield* host.recordHandoffs([handoff])
      expect(yield* host.snapshot).toEqual(first)
      expect(first[0]?.artifact).toBeNull()
      expect(first[0]?.repairAttempts).toBe(1)
      expect(migratedHandoff({ ...handoff, repairStartedHeadSha: 'unknown' }, 0).status._tag).toBe(
        'Intervention',
      )
    }),
  )

  it.effect('persists intent before a remote write and preserves success across pause', () =>
    Effect.gen(function* () {
      const store = yield* memoryStore
      const host = yield* makeDurableHost(store)
      yield* host.recordHandoffs([handoff])
      const entered = yield* Deferred.make<void>()
      const complete = yield* Deferred.make<void>()
      const operation = yield* host
        .external(
          '42',
          'merge',
          'head',
          Effect.gen(function* () {
            expect((yield* store.list.pipe(Effect.orDie))[0]?.externalOperation).toMatchObject({
              kind: 'merge',
              headSha: 'head',
              outcome: 'pending',
            })
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(complete)
            return 'merge-sha'
          }),
        )
        .pipe(Effect.fork)
      yield* Deferred.await(entered)
      yield* host.setIntent(handoff.identifier, 'paused')
      yield* Deferred.succeed(complete, undefined)
      expect(yield* Fiber.join(operation)).toBe('merge-sha')
      expect((yield* host.snapshot)[0]).toMatchObject({
        intent: 'paused',
        externalOperation: { outcome: 'succeeded' },
      })
      let wrote = false
      yield* host
        .external(
          '42',
          'request_review',
          'head',
          Effect.sync(() => {
            wrote = true
          }),
        )
        .pipe(Effect.either)
      expect(wrote).toBe(false)
    }),
  )

  it.effect('restores a pending write as unknown and refuses duplicate ownership', () =>
    Effect.gen(function* () {
      const store = yield* memoryStore
      const host = yield* makeDurableHost(store)
      yield* host.recordHandoffs([handoff])
      const entered = yield* Deferred.make<void>()
      const operation = yield* host
        .external(
          '42',
          'request_review',
          'head',
          Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
        )
        .pipe(Effect.fork)
      yield* Deferred.await(entered)
      let duplicate = false
      yield* host
        .external(
          '42',
          'merge',
          'head',
          Effect.sync(() => {
            duplicate = true
          }),
        )
        .pipe(Effect.either)
      expect(duplicate).toBe(false)
      const restarted = yield* makeDurableHost(store)
      expect((yield* restarted.snapshot)[0]?.externalOperation?.outcome).toBe('unknown')
      // A second host is only a simulated restart here; do not let the old writer mutate its revision.
      yield* Fiber.interrupt(operation)
    }),
  )
})
