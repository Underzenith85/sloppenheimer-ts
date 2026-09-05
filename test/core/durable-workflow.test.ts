import { it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Option, Ref, TestClock } from 'effect'
import { describe, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DurableWorkflow } from '@sloppenheimer/core/domain/durable-workflow.js'
import { transitionWorkflow } from '@sloppenheimer/core/core/durable/transition.js'
import { WorkflowStore, type WorkflowStorePort } from '@sloppenheimer/core/ports/workflow-store.js'
import { WorkflowStoreError } from '@sloppenheimer/core/domain/errors.js'
import { executeWorkflowOperation } from '@sloppenheimer/core/core/durable/execute.js'
import { openWorkflowStore } from '@sloppenheimer/adapter-node/workflow-store.js'

const initial = (): DurableWorkflow => ({
  version: 1,
  issueId: '42',
  identifier: 'example/project#42',
  objective: 'Implement a change',
  revision: 0,
  intent: 'active',
  status: {
    _tag: 'Queued',
    operation: {
      id: '42:implement:1',
      generation: 1,
      kind: 'implement',
      inputRevision: 'baseline',
      attempt: 0,
      timeoutMs: 1_000,
    },
  },
  artifact: null,
  codingAttempts: 0,
  repairAttempts: 0,
  maximumCodingAttempts: 2,
  maximumRepairAttempts: 2,
  budgetDeadline: 10_000,
  lastProgressAt: 0,
  lastFailureSignature: null,
  repeatedFailures: 0,
  updatedAt: 0,
})
const started = (workflow: DurableWorkflow): DurableWorkflow =>
  transitionWorkflow(
    workflow,
    { _tag: 'Started', operationId: '42:implement:1', generation: 1 },
    10,
  )

describe('durable issue workflow', () => {
  it.effect('does not spend an attempt while waiting or paused', () =>
    Effect.sync(() => {
      const workflow = initial()
      const paused = transitionWorkflow(workflow, { _tag: 'IntentChanged', intent: 'paused' }, 1)
      expect(started(paused)).toBe(paused)
      expect(paused.codingAttempts).toBe(0)
      expect(started(workflow).codingAttempts).toBe(1)
    }),
  )

  it.effect('fences duplicate and stale settlements', () =>
    Effect.sync(() => {
      const workflow = started(initial())
      const stale = transitionWorkflow(
        workflow,
        {
          _tag: 'Settled',
          operationId: '42:implement:1',
          generation: 2,
          outcome: 'succeeded',
          next: { _tag: 'Completed', headSha: 'wrong' },
          artifact: null,
          failureSignature: null,
        },
        20,
      )
      expect(stale).toBe(workflow)
      const event = {
        _tag: 'Settled',
        operationId: '42:implement:1',
        generation: 1,
        outcome: 'succeeded',
        next: { _tag: 'Completed', headSha: 'verified' },
        artifact: null,
        failureSignature: null,
      } as const
      const settled = transitionWorkflow(workflow, event, 20)
      expect(transitionWorkflow(settled, event, 21)).toBe(settled)
    }),
  )

  it.effect('refuses publication and completion without exact verification evidence', () =>
    Effect.sync(() => {
      const workflow = initial()
      if (workflow.status._tag !== 'Queued') {
        return
      }
      const publication: DurableWorkflow = {
        ...workflow,
        status: {
          _tag: 'Queued',
          operation: { ...workflow.status.operation, kind: 'publish' },
        },
      }
      expect(started(publication).status).toEqual({
        _tag: 'Intervention',
        reason: 'Publication requires verification of its exact input',
      })
      const completed = transitionWorkflow(
        started(workflow),
        {
          _tag: 'Settled',
          operationId: '42:implement:1',
          generation: 1,
          outcome: 'succeeded',
          next: { _tag: 'Completed', headSha: 'unverified' },
          artifact: null,
          failureSignature: null,
        },
        20,
      )
      expect(completed.status._tag).toBe('Intervention')
    }),
  )

  it.effect('preserves publication evidence when cancellation overtakes settlement', () =>
    Effect.sync(() => {
      const cancelled = transitionWorkflow(
        started(initial()),
        {
          _tag: 'IntentChanged',
          intent: 'cancelled',
        },
        11,
      )
      expect(cancelled.status._tag).toBe('Stopping')
      const settled = transitionWorkflow(
        cancelled,
        {
          _tag: 'Settled',
          operationId: '42:implement:1',
          generation: 1,
          outcome: 'succeeded',
          next: { _tag: 'Waiting', condition: 'eligibility', deadline: 100 },
          artifact: {
            id: 'candidate',
            workspacePath: '/workspace/run',
            workspaceKey: 'run',
            baselineSha: 'base',
            candidateRevision: 'candidate',
            expectedRemoteHead: 'base',
            verifiedRevision: 'candidate',
            publishedHead: 'published',
          },
          failureSignature: null,
        },
        20,
      )
      expect(settled.intent).toBe('cancelled')
      expect(settled.artifact?.publishedHead).toBe('published')
    }),
  )

  it.effect('claims before executing and cannot launch the same generation twice', () =>
    Effect.gen(function* () {
      const cell = yield* Ref.make(initial())
      const store: WorkflowStorePort = {
        get: () => Effect.map(Ref.get(cell), Option.some),
        list: Effect.map(Ref.get(cell), (value) => [value]),
        commit: (next: DurableWorkflow, expected: number | null) =>
          Ref.modify(cell, (current) => [
            current.revision === expected,
            current.revision === expected ? next : current,
          ]).pipe(
            Effect.flatMap((accepted) =>
              accepted
                ? Effect.void
                : Effect.fail(
                    new WorkflowStoreError({ category: 'conflict', message: 'stale writer' }),
                  ),
            ),
          ),
      }
      const launched = yield* Deferred.make<void>()
      let executions = 0
      let finalized = false
      const execute = executeWorkflowOperation('42', '42:implement:1', 1, () =>
        Effect.gen(function* () {
          executions += 1
          expect((yield* Ref.get(cell)).status._tag).toBe('Executing')
          yield* Deferred.succeed(launched, undefined)
          return yield* Effect.never
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true
            }),
          ),
        ),
      ).pipe(Effect.provideService(WorkflowStore, store))
      const fiber = yield* Effect.fork(execute)
      yield* Deferred.await(launched)
      yield* execute
      expect(executions).toBe(1)
      yield* TestClock.adjust(1_001)
      yield* Fiber.join(fiber)
      expect(finalized).toBe(true)
      expect((yield* Ref.get(cell)).status._tag).toBe('Reconciling')
      expect((yield* Ref.get(cell)).codingAttempts).toBe(1)
    }),
  )

  it.live('commits commands atomically, rejects stale writers, and reconciles across restart', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), 'sloppenheimer-durable-'))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        )
        const path = join(root, 'workflows.sqlite')
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openWorkflowStore(path)
            yield* store.commit(initial(), null)
            const execution = started(initial())
            yield* store.commit(execution, 0)
            const refused = yield* Effect.flip(store.commit(execution, 0))
            expect(refused.category).toBe('conflict')
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openWorkflowStore(path)
            const restored = yield* store.get('42')
            expect(Option.isSome(restored)).toBe(true)
            if (Option.isNone(restored)) {
              return
            }
            expect(restored.value.status._tag).toBe('Executing')
            const recovered = transitionWorkflow(restored.value, { _tag: 'Recovered' }, 30)
            yield* store.commit(recovered, restored.value.revision)
            expect(recovered.status._tag).toBe('Reconciling')
            expect(yield* store.list).toEqual([recovered])
          }),
        )
      }),
    ),
  )
})
