import { it } from '@effect/vitest'
import { Deferred, Effect, Exit, Fiber, Option, Ref, TestClock } from 'effect'
import { describe, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeDurableHost } from '@sloppenheimer/core/core/durable/live-journal.js'
import type { DurableWorkflow } from '@sloppenheimer/core/domain/durable-workflow.js'
import { SourceControlError, WorkflowStoreError } from '@sloppenheimer/core/domain/errors.js'
import type { WorkflowStorePort } from '@sloppenheimer/core/ports/workflow-store.js'
import { openWorkflowStore } from '@sloppenheimer/adapter-node/workflow-store.js'
import { anIssue } from '../harness/fixtures.js'

const issue = anIssue()
const target = { _tag: 'Normal', branchName: 'candidate/test' } as const
const prepared = {
  repositoryIdentity: 'repository',
  target,
  workspace: { key: 'retained', path: '/retained/work' },
  baselineSha: 'baseline',
  baseSha: 'baseline',
  baseBranch: 'main',
  expectedRemoteHead: Option.none<string>(),
}
const candidate = { prepared, headSha: 'candidate', treeSha: 'tree', commitCreated: true }
const verified = {
  candidate,
  evidence: { headSha: 'candidate', treeSha: 'tree', command: 'pnpm check', verifiedAt: 1 },
}
const published = {
  _tag: 'Published',
  branchName: target.branchName,
  headSha: 'candidate',
  baselineSha: 'baseline',
  commitCreated: true,
} as const

const memoryStore = Effect.gen(function* () {
  const records = yield* Ref.make<ReadonlyMap<string, DurableWorkflow>>(new Map())
  const store: WorkflowStorePort = {
    list: Ref.get(records).pipe(Effect.map((rows) => [...rows.values()])),
    get: (id) => Ref.get(records).pipe(Effect.map((rows) => Option.fromNullable(rows.get(id)))),
    commit: (record, expected) =>
      Ref.modify(records, (rows) => {
        if ((rows.get(record.issueId)?.revision ?? null) !== expected) {
          return [false, rows] as const
        }
        return [true, new Map([...rows, [record.issueId, record]])] as const
      }).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Effect.fail(new WorkflowStoreError({ category: 'conflict', message: 'stale write' })),
        ),
      ),
  }
  return store
})

describe('live durable journal', () => {
  it.effect('commits admission before returning a run and refuses duplicate dispatch', () =>
    Effect.gen(function* () {
      const store = yield* memoryStore
      const host = yield* makeDurableHost(store)
      const first = yield* host.start(issue, target)
      expect(Option.isSome(first)).toBe(true)
      expect((yield* store.list)[0]?.status._tag).toBe('Executing')
      expect(Option.isNone(yield* host.start(issue, target))).toBe(true)
      expect((yield* store.list)[0]?.codingAttempts).toBe(1)
    }),
  )

  it.effect('preserves exact candidate and verification evidence across host restart', () =>
    Effect.gen(function* () {
      const store = yield* memoryStore
      const host = yield* makeDurableHost(store)
      const journal = yield* host.start(issue, target).pipe(Effect.map(Option.getOrThrow))
      yield* journal.prepared(prepared)
      yield* journal.publication.checkpointing
      yield* journal.publication.checkpointed(candidate)
      yield* journal.publication.aligned(candidate)
      yield* journal.publication.verified({
        candidate,
        evidence: {
          headSha: candidate.headSha,
          treeSha: candidate.treeSha,
          command: 'pnpm check',
          verifiedAt: 1,
        },
      })
      const beforePush = (yield* store.list)[0]
      expect(beforePush?.artifact?.repository?.headSha).toBe('candidate')
      expect(beforePush?.artifact?.verifiedRevision).toBe('tree')
      expect(beforePush?.artifact?.publishedHead).toBe(null)
      const recovered = yield* makeDurableHost(store)
      expect((yield* recovered.snapshot)[0]?.status._tag).toBe('Intervention')
      expect((yield* recovered.snapshot)[0]?.artifact).toEqual(beforePush?.artifact)
      expect(Option.isNone(yield* recovered.start(issue, target))).toBe(true)
    }),
  )

  it.effect('preserves repair budgets across restart and refuses a fourth mutation', () =>
    Effect.gen(function* () {
      const store = yield* memoryStore
      let host = yield* makeDurableHost(store)
      const first = yield* host.start(issue, target).pipe(Effect.map(Option.getOrThrow))
      yield* first.prepared(prepared)
      yield* first.publication.verified(verified)
      yield* first.settled(published)
      const deadline = (yield* store.list)[0]?.budgetDeadline
      const repair = {
        _tag: 'Repair',
        branchName: target.branchName,
        expectedHeadSha: 'candidate',
      } as const
      for (let attempt = 0; attempt < 3; attempt += 1) {
        host = yield* makeDurableHost(store)
        const journal = yield* host.start(issue, repair).pipe(Effect.map(Option.getOrThrow))
        yield* journal.prepared(prepared)
        yield* journal.publication.verified(verified)
        yield* journal.settled(published)
      }
      expect(Option.isNone(yield* host.start(issue, repair))).toBe(true)
      const record = (yield* host.snapshot)[0]
      expect(record?.repairAttempts).toBe(3)
      expect(record?.budgetDeadline).toBe(deadline)
      expect(record?.status._tag).toBe('Intervention')
    }),
  )

  it.effect('pauses the persisted workflow before allowing another candidate mutation', () =>
    Effect.gen(function* () {
      const host = yield* memoryStore.pipe(Effect.flatMap(makeDurableHost))
      const journal = yield* host.start(issue, target).pipe(Effect.map(Option.getOrThrow))
      yield* journal.prepared(prepared)
      yield* host.setIntent(issue.identifier, 'paused')
      const attempted = yield* Effect.fork(journal.publication.checkpointing)
      expect(Exit.isInterrupted(yield* Fiber.await(attempted))).toBe(true)
      expect((yield* host.snapshot)[0]?.intent).toBe('paused')
    }),
  )

  it.effect('fences callbacks from a previous run after repair admission', () =>
    Effect.gen(function* () {
      const host = yield* memoryStore.pipe(Effect.flatMap(makeDurableHost))
      const first = yield* host.start(issue, target).pipe(Effect.map(Option.getOrThrow))
      yield* first.prepared(prepared)
      yield* first.publication.verified(verified)
      yield* first.settled(published)
      yield* host.start(issue, {
        _tag: 'Repair',
        branchName: target.branchName,
        expectedHeadSha: 'candidate',
      })
      const stale = yield* Effect.fork(first.settled(published))
      expect(Exit.isInterrupted(yield* Fiber.await(stale))).toBe(true)
      expect((yield* host.snapshot)[0]?.status._tag).toBe('Executing')
    }),
  )

  it.effect('rejects repair after the original total deadline', () =>
    Effect.gen(function* () {
      const host = yield* memoryStore.pipe(Effect.flatMap(makeDurableHost))
      const journal = yield* host.start(issue, target).pipe(Effect.map(Option.getOrThrow))
      yield* journal.prepared(prepared)
      yield* journal.publication.verified(verified)
      yield* journal.settled(published)
      yield* TestClock.adjust(86_400_001)
      expect(
        Option.isNone(
          yield* host.start(issue, {
            _tag: 'Repair',
            branchName: target.branchName,
            expectedHeadSha: 'candidate',
          }),
        ),
      ).toBe(true)
    }),
  )

  it.effect('fails the host supervisor and interrupts dispatch on persistence failure', () =>
    Effect.gen(function* () {
      const original = yield* memoryStore
      const store: WorkflowStorePort = {
        ...original,
        commit: () =>
          Effect.fail(new WorkflowStoreError({ category: 'storage', message: 'disk full' })),
      }
      const host = yield* makeDurableHost(store)
      const dispatch = yield* Effect.fork(host.start(issue, target))
      const failure = yield* Effect.flip(host.awaitFailure)
      expect(failure.message).toContain('host stopped')
      expect(Exit.isInterrupted(yield* Fiber.await(dispatch))).toBe(true)
      expect(yield* host.snapshot).toEqual([])
    }),
  )

  it.live('holds exclusive host authority until the owning scope closes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), 'sloppenheimer-authority-'))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        )
        const path = join(root, 'workflow.sqlite')
        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* openWorkflowStore(path, true)
            expect(yield* first.list).toEqual([])
            yield* Effect.scoped(
              Effect.gen(function* () {
                const second = yield* openWorkflowStore(path, true)
                const refused = yield* Effect.flip(second.list)
                expect(refused._tag).toBe('WorkflowStoreError')
              }),
            )
          }),
        )
        const next = yield* openWorkflowStore(path, true)
        expect(yield* next.list).toEqual([])
      }),
    ),
  )
})

const pendingPublication = Effect.gen(function* () {
  const store = yield* memoryStore
  const host = yield* makeDurableHost(store)
  const journal = yield* host.start(issue, target).pipe(Effect.map(Option.getOrThrow))
  yield* journal.prepared(prepared)
  yield* journal.publication.verified(verified)
  return { store, host: yield* makeDurableHost(store) }
})

it.effect('records a matching remote fact while keeping paused work quarantined', () =>
  Effect.gen(function* () {
    const { host } = yield* pendingPublication
    yield* host.setIntent(issue.identifier, 'paused')
    yield* host.reconcilePublication(issue.id, {
      repositoryIdentity: 'repository',
      observeHead: () => Effect.succeed(Option.some('candidate')),
    })
    const record = (yield* host.snapshot)[0]
    expect(record?.artifact?.publishedHead).toBe('candidate')
    expect(record?.artifact?.remoteObservation?.headSha).toBe('candidate')
    expect(record?.status._tag).toBe('Intervention')
    expect(record?.intent).toBe('paused')
    expect(Option.isNone(yield* host.start(issue, target))).toBe(true)
  }),
)

it.effect('does not redirect recovery when the configured repository changed', () =>
  Effect.gen(function* () {
    const { host } = yield* pendingPublication
    yield* host.reconcilePublication(issue.id, {
      repositoryIdentity: 'another-repository',
      observeHead: () => Effect.die('a different remote must never be consulted'),
    })
    expect((yield* host.snapshot)[0]?.artifact?.remoteObservation).toBeUndefined()
  }),
)

it.effect('preserves unknown and divergent remote outcomes without granting publication', () =>
  Effect.gen(function* () {
    const { host } = yield* pendingPublication
    yield* host.reconcilePublication(issue.id, {
      repositoryIdentity: 'repository',
      observeHead: () =>
        Effect.fail(
          new SourceControlError({
            category: 'authentication_failed',
            message: 'provider diagnostic',
            retryable: true,
            worktreePreserved: true,
          }),
        ),
    })
    expect((yield* host.snapshot)[0]?.artifact?.remoteObservation).toBeUndefined()
    yield* host.reconcilePublication(issue.id, {
      repositoryIdentity: 'repository',
      observeHead: () => Effect.succeed(Option.some('different')),
    })
    expect((yield* host.snapshot)[0]?.artifact?.publishedHead).toBeNull()
    expect((yield* host.snapshot)[0]?.artifact?.remoteObservation?.headSha).toBe('different')
    yield* host.reconcilePublication(issue.id, {
      repositoryIdentity: 'repository',
      observeHead: () => Effect.succeed(Option.none()),
    })
    expect((yield* host.snapshot)[0]?.artifact?.remoteObservation?.headSha).toBeNull()
    expect((yield* host.snapshot)[0]?.status._tag).toBe('Intervention')
  }),
)

it.effect('refuses a stale remote observation after operator intent changes', () =>
  Effect.gen(function* () {
    const { host } = yield* pendingPublication
    const started = yield* Deferred.make<void>()
    const answer = yield* Deferred.make<Option.Option<string>>()
    const reading = yield* Effect.fork(
      host.reconcilePublication(issue.id, {
        repositoryIdentity: 'repository',
        observeHead: () =>
          Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(answer))),
      }),
    )
    yield* Deferred.await(started)
    yield* host.setIntent(issue.identifier, 'paused')
    yield* Deferred.succeed(answer, Option.some('candidate'))
    yield* Fiber.join(reading)
    expect((yield* host.snapshot)[0]?.intent).toBe('paused')
    expect((yield* host.snapshot)[0]?.artifact?.remoteObservation).toBeUndefined()
  }),
)

it.effect('keeps legacy records without remote provenance held without guessing a repository', () =>
  Effect.gen(function* () {
    const { store } = yield* pendingPublication
    const record = (yield* store.list)[0]
    if (record === undefined || record.artifact?.repository === undefined) {
      return yield* Effect.die('fixture must contain repository evidence')
    }
    const { identity: ignored, ...repository } = record.artifact.repository
    void ignored
    yield* store.commit(
      { ...record, revision: record.revision + 1, artifact: { ...record.artifact, repository } },
      record.revision,
    )
    const host = yield* makeDurableHost(store)
    yield* host.reconcilePublication(issue.id, {
      repositoryIdentity: 'repository',
      observeHead: () => Effect.die('legacy provenance must not be guessed'),
    })
    expect((yield* host.snapshot)[0]?.artifact?.remoteObservation).toBeUndefined()
  }),
)

it.effect('persists non-handoff continuations across restart and bounds coding attempts', () =>
  Effect.gen(function* () {
    const store = yield* memoryStore
    let host = yield* makeDurableHost(store)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const journal = yield* host
        .start(issue, target, 'continuation')
        .pipe(Effect.map(Option.getOrThrow))
      yield* journal.prepared(prepared)
      yield* journal.publication.verified(verified)
      yield* journal.settled(published)
      expect((yield* host.snapshot)[0]?.status).toMatchObject({
        _tag: 'Waiting',
        condition: 'continuation',
      })
      host = yield* makeDurableHost(store)
    }
    expect(Option.isNone(yield* host.start(issue, target, 'continuation'))).toBe(true)
    expect((yield* host.snapshot)[0]?.codingAttempts).toBe(3)
    expect((yield* host.snapshot)[0]?.repairAttempts).toBe(0)
    expect((yield* host.snapshot)[0]?.status._tag).toBe('Intervention')
  }),
)

it.effect('allows a clean non-handoff continuation without inventing publication', () =>
  Effect.gen(function* () {
    const store = yield* memoryStore
    const host = yield* makeDurableHost(store)
    const journal = yield* host
      .start(issue, target, 'continuation')
      .pipe(Effect.map(Option.getOrThrow))
    yield* journal.prepared(prepared)
    yield* journal.settled({
      _tag: 'NoChanges',
      branchName: target.branchName,
      baselineSha: prepared.baselineSha,
    })
    const restored = yield* makeDurableHost(store)
    expect((yield* restored.snapshot)[0]?.artifact?.publishedHead).toBeNull()
    expect(Option.isSome(yield* restored.start(issue, target, 'continuation'))).toBe(true)
  }),
)

it.effect(
  'records verified publication facts after a pause without authorizing further mutation',
  () =>
    Effect.gen(function* () {
      const host = yield* memoryStore.pipe(Effect.flatMap(makeDurableHost))
      const journal = yield* host.start(issue, target).pipe(Effect.map(Option.getOrThrow))
      yield* journal.prepared(prepared)
      yield* journal.publication.aligned(candidate)
      yield* host.setIntent(issue.identifier, 'paused')
      yield* journal.publication.verified(verified)
      yield* journal.publication.published(published)
      expect((yield* host.snapshot)[0]).toMatchObject({
        intent: 'paused',
        status: { _tag: 'Waiting', condition: 'review' },
        artifact: { publishedHead: 'candidate', verifiedRevision: 'tree' },
      })
      const mutation = yield* Effect.fork(journal.publication.checkpointing)
      expect(Exit.isInterrupted(yield* Fiber.await(mutation))).toBe(true)
    }),
)
