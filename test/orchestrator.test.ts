import { resolve } from 'node:path'
import { Deferred, Effect, TestClock, TestContext } from 'effect'
import { describe, expect, it } from 'vitest'

import type { AgentResult } from '../src/codex.js'
import { cyclicIssueIdentifiers, findDependencyCycles } from '../src/dependencies.js'
import { issueId, issueIdentifier, type BlockerRef, type Issue } from '../src/domain.js'
import { AgentError, TrackerError } from '../src/errors.js'
import {
  issueIsRoutable,
  retryDelayMs,
  sortIssues,
  startOrchestrator,
  type OrchestratorControl,
  type OrchestratorDependencies,
  type OrchestratorSnapshot,
} from '../src/orchestrator.js'
import type { TrackerAdapter } from '../src/tracker.js'
import type { WorkspaceManager } from '../src/workspace.js'
import type { Workflow } from '../src/workflow.js'

const makeIssue = (
  identifier: string,
  priority: number | null,
  createdAt: string | null,
  labels: readonly string[] = ['symphony'],
  blockedBy: readonly BlockerRef[] = [],
): Issue => ({
  id: issueId(identifier),
  nativeRef: null,
  identifier: issueIdentifier(identifier),
  title: identifier,
  description: null,
  priority,
  state: 'open',
  branchName: null,
  url: null,
  assigneeId: null,
  labels,
  blockedBy,
  dispatchable: true,
  createdAt: createdAt === null ? null : new Date(createdAt),
  updatedAt: null,
})

const workflow: Workflow = {
  path: '/tmp/WORKFLOW.md',
  fingerprint: 'test',
  promptTemplate: 'test',
  config: {
    tracker: {
      kind: 'github',
      provider: {
        owner: 'example',
        repository: 'symphony',
        token: 'secret',
        apiBaseUrl: 'https://api.github.com',
        baseBranch: 'main',
      },
      requiredLabels: ['symphony', 'ready'],
      activeStates: ['open'],
      terminalStates: ['closed'],
    },
    pollingIntervalMs: 30_000,
    workspaceRoot: '/tmp/symphony',
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 1,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: new Map(),
    },
    codex: {
      command: 'codex app-server',
      approvalPolicy: 'never',
      threadSandbox: 'workspace-write',
      turnTimeoutMs: 60_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 30_000,
    },
    serverPort: null,
  },
}

const actorWorkflowPath = resolve(import.meta.dirname, 'fixtures/orchestrator-workflow.md')

type ActorHarness = Readonly<{
  candidates: { value: readonly Issue[] }
  dependencies: OrchestratorDependencies
  refresh: {
    value: (
      ids: readonly ReturnType<typeof issueId>[],
    ) => ReturnType<TrackerAdapter['fetchIssuesByIds']>
  }
  removals: string[]
  worker: { value: Effect.Effect<AgentResult, AgentError> }
}>

const makeActorHarness = (): ActorHarness => {
  const candidates = { value: [] as readonly Issue[] }
  const refresh: ActorHarness['refresh'] = { value: () => Effect.succeed([]) }
  const removals: string[] = []
  const worker: ActorHarness['worker'] = { value: Effect.never }
  const tracker: TrackerAdapter = {
    fetchIssuesByStates: () => Effect.succeed(candidates.value),
    fetchIssuesByIds: (ids) => refresh.value(ids),
    handoffCompletedWork: (issue) =>
      Effect.succeed({ _tag: 'NoBranch', branchName: `symphony/${issue.identifier}` }),
    secretEnvironmentNames: [],
  }
  const workspaces: WorkspaceManager = {
    create: (identifier) =>
      Effect.succeed({ path: `/tmp/${identifier}`, key: identifier, createdNow: false }),
    beforeRun: () => Effect.void,
    afterRun: () => Effect.void,
    remove: (identifier) =>
      Effect.sync(() => {
        removals.push(identifier)
      }),
  }
  return {
    candidates,
    refresh,
    removals,
    worker,
    dependencies: {
      makeTracker: () => tracker,
      makeWorkspaces: () => workspaces,
      pollAutomatically: false,
      runAgent: () => worker.value,
      watchWorkflow: false,
    },
  }
}

const settle = (control: OrchestratorControl): Effect.Effect<void> =>
  control.settle ?? Effect.dieMessage('test orchestrator has no settle barrier')

const awaitSnapshot = (
  control: OrchestratorControl,
  predicate: (snapshot: OrchestratorSnapshot) => boolean,
): Effect.Effect<OrchestratorSnapshot> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      yield* Effect.yieldNow()
      yield* settle(control)
      const snapshot = yield* control.snapshot
      if (predicate(snapshot)) {
        return snapshot
      }
    }
    return yield* Effect.dieMessage('orchestrator did not reach the expected state')
  })

const runActorTest = async (
  harness: ActorHarness,
  test: (control: OrchestratorControl) => Effect.Effect<void>,
): Promise<void> => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(0)
        const control = yield* startOrchestrator(actorWorkflowPath, harness.dependencies)
        yield* control.refresh
        yield* settle(control)
        yield* test(control)
      }),
    ).pipe(Effect.provide(TestContext.TestContext)),
  )
}

const releaseWorker = (
  deferred: Deferred.Deferred<AgentResult, AgentError>,
  result: 'normal' | 'failed',
): Effect.Effect<void> =>
  result === 'normal'
    ? Deferred.succeed(deferred, { threadId: 'thread', turnId: 'turn', turnCount: 1 }).pipe(
        Effect.asVoid,
      )
    : Deferred.fail(
        deferred,
        new AgentError({ category: 'process_exited', message: 'worker exploded' }),
      ).pipe(Effect.asVoid)

describe('orchestrator policies', (): void => {
  it('orders valid priority first, then creation time, then identifier', (): void => {
    const issues = [
      makeIssue('GH-3', null, '2026-01-01T00:00:00.000Z'),
      makeIssue('GH-2', 1, '2026-02-01T00:00:00.000Z'),
      makeIssue('GH-1', 1, '2026-01-01T00:00:00.000Z'),
    ]

    expect(sortIssues(issues).map((issue) => issue.identifier)).toEqual(['GH-1', 'GH-2', 'GH-3'])
  })

  it('caps exponential retry backoff', (): void => {
    expect(retryDelayMs(1, 300_000)).toBe(10_000)
    expect(retryDelayMs(3, 300_000)).toBe(40_000)
    expect(retryDelayMs(99, 300_000)).toBe(300_000)
  })

  it('matches required labels case-insensitively', (): void => {
    expect(issueIsRoutable(makeIssue('GH-1', 1, null, ['Ready', 'SYMPHONY']), workflow)).toBe(true)
    expect(issueIsRoutable(makeIssue('GH-2', 1, null, ['symphony']), workflow)).toBe(false)
  })

  it('does not route an issue until its final native blocker is terminal', (): void => {
    const openBlocker: BlockerRef = {
      id: '101',
      identifier: issueIdentifier('example/symphony#1'),
      title: 'Foundation',
      state: 'open',
      url: 'https://github.com/example/symphony/issues/1',
    }
    const blocked = makeIssue('example/symphony#2', 1, null, ['ready', 'symphony'], [openBlocker])
    const ready = { ...blocked, blockedBy: [{ ...openBlocker, state: 'closed' }] }

    expect(issueIsRoutable(blocked, workflow)).toBe(false)
    expect(issueIsRoutable(ready, workflow)).toBe(true)
  })

  it('detects cycle members while leaving independent, chain, and diamond work acyclic', (): void => {
    const blocker = (identifier: string): BlockerRef => ({
      id: identifier,
      identifier: issueIdentifier(identifier),
      title: identifier,
      state: 'open',
      url: `https://github.com/${identifier.replace('#', '/issues/')}`,
    })
    const issue = (number: number, blockers: readonly number[] = []): Issue =>
      makeIssue(
        `example/symphony#${String(number)}`,
        null,
        null,
        ['ready', 'symphony'],
        blockers.map((number) => blocker(`example/symphony#${String(number)}`)),
      )
    const graph = [
      issue(1),
      issue(2, [1]),
      issue(3, [1]),
      issue(4, [2, 3]),
      issue(5),
      issue(6, [7]),
      issue(7, [6]),
    ]

    expect(findDependencyCycles(graph)).toEqual([
      {
        members: ['example/symphony#6', 'example/symphony#7'],
        message: 'Dependency cycle members: example/symphony#6, example/symphony#7',
      },
    ])
    expect([...cyclicIssueIdentifiers(graph)]).toEqual(['example/symphony#6', 'example/symphony#7'])
  })
})

describe('orchestrator actor transitions', (): void => {
  it('keeps workers on refresh failure and cancels an omitted ID without cleanup', async (): Promise<void> => {
    const harness = makeActorHarness()
    const issue = makeIssue('GH-1', 1, null, ['ready'])
    harness.candidates.value = [issue]

    await runActorTest(harness, (control) =>
      Effect.gen(function* () {
        harness.candidates.value = []
        yield* TestClock.adjust(5_000)
        harness.refresh.value = (): ReturnType<TrackerAdapter['fetchIssuesByIds']> =>
          Effect.fail(
            new TrackerError({
              category: 'tracker_request',
              message: 'network unavailable',
              retryable: true,
            }),
          )
        yield* control.refresh
        yield* settle(control)
        expect((yield* control.snapshot).counts.running).toBe(1)

        harness.refresh.value = (): ReturnType<TrackerAdapter['fetchIssuesByIds']> =>
          Effect.succeed([])
        yield* control.refresh
        yield* settle(control)
        yield* settle(control)
        const snapshot = yield* control.snapshot
        expect(snapshot.counts).toMatchObject({ running: 0, retrying: 0 })
        expect(snapshot.totals.secondsRunning).toBe(5)
        expect(harness.removals).toEqual([])
      }),
    )
  })

  it.each([
    { name: 'terminal', state: 'closed', cleanup: true },
    { name: 'non-active', state: 'paused', cleanup: false },
  ])('cancels a $name running issue and accounts runtime once', async ({ state, cleanup }) => {
    const harness = makeActorHarness()
    const issue = makeIssue('GH-1', 1, null, ['ready'])
    harness.candidates.value = [issue]

    await runActorTest(harness, (control) =>
      Effect.gen(function* () {
        harness.candidates.value = []
        yield* TestClock.adjust(2_000)
        harness.refresh.value = (): ReturnType<TrackerAdapter['fetchIssuesByIds']> =>
          Effect.succeed([{ ...issue, state }])
        yield* control.refresh
        yield* settle(control)
        yield* settle(control)
        const snapshot = yield* control.snapshot
        expect(snapshot.counts.running).toBe(0)
        expect(snapshot.totals.secondsRunning).toBe(2)
        expect(harness.removals).toEqual(cleanup ? ['GH-1'] : [])
      }),
    )
  })

  it('keeps and updates an active running issue even when it becomes unroutable', async (): Promise<void> => {
    const harness = makeActorHarness()
    const issue = makeIssue('GH-1', 1, null, ['ready'])
    harness.candidates.value = [issue]

    await runActorTest(harness, (control) =>
      Effect.gen(function* () {
        harness.candidates.value = []
        harness.refresh.value = (): ReturnType<TrackerAdapter['fetchIssuesByIds']> =>
          Effect.succeed([{ ...issue, title: 'Updated title', labels: [] }])
        yield* control.refresh
        yield* settle(control)
        const snapshot = yield* control.snapshot
        expect(snapshot.counts.running).toBe(1)
        expect(snapshot.running[0]?.title).toBe('Updated title')
      }),
    )
  })

  it.each(['normal', 'failed'] as const)(
    'accounts a %s worker exit and schedules the expected retry',
    async (result) => {
      const harness = makeActorHarness()
      const issue = makeIssue('GH-1', 1, null, ['ready'])
      const program = Effect.gen(function* () {
        const deferred = yield* Deferred.make<AgentResult, AgentError>()
        harness.worker.value = Deferred.await(deferred)
        harness.candidates.value = [issue]
        yield* Effect.scoped(
          Effect.gen(function* () {
            const control = yield* startOrchestrator(actorWorkflowPath, harness.dependencies)
            yield* control.refresh
            yield* settle(control)
            harness.candidates.value = []
            yield* TestClock.adjust(3_000)
            yield* releaseWorker(deferred, result)
            yield* Effect.yieldNow()
            yield* settle(control)
            yield* settle(control)
            const snapshot = yield* control.snapshot
            expect(snapshot.counts).toMatchObject({ running: 0, retrying: 1 })
            expect(snapshot.totals.secondsRunning).toBe(3)
            expect(snapshot.retrying[0]?.attempt).toBe(1)
            expect(snapshot.retrying[0]?.error).toBe(result === 'normal' ? null : 'worker exploded')
          }),
        )
      }).pipe(Effect.provide(TestContext.TestContext))
      await Effect.runPromise(program)
    },
  )

  it('accounts a stalled worker once and requeues it as a failure', async (): Promise<void> => {
    const harness = makeActorHarness()
    const issue = makeIssue('GH-1', 1, null, ['ready'])
    harness.candidates.value = [issue]

    await runActorTest(harness, (control) =>
      Effect.gen(function* () {
        harness.candidates.value = []
        yield* TestClock.adjust(30_001)
        yield* control.refresh
        yield* settle(control)
        yield* settle(control)
        const snapshot = yield* control.snapshot
        expect(snapshot.counts).toMatchObject({ running: 0, retrying: 1 })
        expect(snapshot.retrying[0]).toMatchObject({ attempt: 1, error: 'agent stalled' })
        expect(snapshot.totals.secondsRunning).toBe(30.001)
      }),
    )
  })

  it('requeues retry-refresh failure with an incremented attempt and explicit error', async (): Promise<void> => {
    const harness = makeActorHarness()
    const issue = makeIssue('GH-1', 1, null, ['ready'])
    const deferred = await Effect.runPromise(Deferred.make<AgentResult, AgentError>())
    harness.worker.value = Deferred.await(deferred)
    harness.candidates.value = [issue]

    await runActorTest(harness, (control) =>
      Effect.gen(function* () {
        harness.candidates.value = []
        yield* releaseWorker(deferred, 'failed')
        yield* awaitSnapshot(control, (snapshot) => snapshot.counts.retrying === 1)
        harness.refresh.value = (): ReturnType<TrackerAdapter['fetchIssuesByIds']> =>
          Effect.fail(
            new TrackerError({
              category: 'tracker_request',
              message: 'refresh transport failed',
              retryable: true,
            }),
          )
        yield* TestClock.adjust(10_000)
        yield* Effect.yieldNow()
        yield* settle(control)
        const snapshot = yield* control.snapshot
        expect(snapshot.retrying[0]).toMatchObject({
          attempt: 2,
          error: 'retry refresh failed: refresh transport failed',
        })
      }),
    )
  })

  it('releases the claim after a successful empty retry refresh', async (): Promise<void> => {
    const harness = makeActorHarness()
    const issue = makeIssue('GH-1', 1, null, ['ready'])
    const deferred = await Effect.runPromise(Deferred.make<AgentResult, AgentError>())
    harness.worker.value = Deferred.await(deferred)
    harness.candidates.value = [issue]

    await runActorTest(harness, (control) =>
      Effect.gen(function* () {
        harness.candidates.value = []
        yield* releaseWorker(deferred, 'failed')
        yield* awaitSnapshot(control, (snapshot) => snapshot.counts.retrying === 1)
        harness.refresh.value = (): ReturnType<TrackerAdapter['fetchIssuesByIds']> =>
          Effect.succeed([])
        yield* TestClock.adjust(10_000)
        yield* awaitSnapshot(
          control,
          (snapshot) => snapshot.counts.running === 0 && snapshot.counts.retrying === 0,
        )

        harness.worker.value = Effect.never
        harness.candidates.value = [issue]
        yield* control.refresh
        const snapshot = yield* awaitSnapshot(
          control,
          (candidate) => candidate.counts.running === 1,
        )
        expect(snapshot.running[0]?.attempt).toBeNull()
      }),
    )
  })

  it.each([
    { name: 'terminal', state: 'closed', labels: ['ready'], cleanup: true },
    { name: 'non-active', state: 'paused', labels: ['ready'], cleanup: false },
    { name: 'active but unroutable', state: 'open', labels: [], cleanup: false },
  ])('releases a retry refreshed as $name', async ({ state, labels, cleanup }) => {
    const harness = makeActorHarness()
    const issue = makeIssue('GH-1', 1, null, ['ready'])
    const deferred = await Effect.runPromise(Deferred.make<AgentResult, AgentError>())
    harness.worker.value = Deferred.await(deferred)
    harness.candidates.value = [issue]

    await runActorTest(harness, (control) =>
      Effect.gen(function* () {
        harness.candidates.value = []
        yield* releaseWorker(deferred, 'failed')
        yield* awaitSnapshot(control, (snapshot) => snapshot.counts.retrying === 1)
        harness.refresh.value = (): ReturnType<TrackerAdapter['fetchIssuesByIds']> =>
          Effect.succeed([{ ...issue, state, labels }])
        yield* TestClock.adjust(10_000)
        yield* Effect.yieldNow()
        yield* settle(control)
        const snapshot = yield* control.snapshot
        expect(snapshot.counts).toMatchObject({ running: 0, retrying: 0 })
        expect(harness.removals).toEqual(cleanup ? ['GH-1'] : [])
      }),
    )
  })

  it('dispatches an active routable retry when a slot is available', async (): Promise<void> => {
    const harness = makeActorHarness()
    const issue = makeIssue('GH-1', 1, null, ['ready'])
    const deferred = await Effect.runPromise(Deferred.make<AgentResult, AgentError>())
    harness.worker.value = Deferred.await(deferred)
    harness.candidates.value = [issue]

    await runActorTest(harness, (control) =>
      Effect.gen(function* () {
        harness.candidates.value = []
        yield* releaseWorker(deferred, 'failed')
        yield* awaitSnapshot(control, (snapshot) => snapshot.counts.retrying === 1)
        harness.worker.value = Effect.never
        harness.refresh.value = (): ReturnType<TrackerAdapter['fetchIssuesByIds']> =>
          Effect.succeed([issue])
        yield* TestClock.adjust(10_000)
        const snapshot = yield* awaitSnapshot(
          control,
          (candidate) => candidate.running[0]?.attempt === 1,
        )
        expect(snapshot.counts).toMatchObject({ running: 1, retrying: 0 })
        expect(snapshot.running[0]?.attempt).toBe(1)
      }),
    )
  })

  it('requeues an active routable retry when all slots are occupied', async (): Promise<void> => {
    const harness = makeActorHarness()
    const retryIssue = makeIssue('GH-1', 1, null, ['ready'])
    const occupyingIssue = makeIssue('GH-2', 1, null, ['ready'])
    const deferred = await Effect.runPromise(Deferred.make<AgentResult, AgentError>())
    harness.worker.value = Deferred.await(deferred)
    harness.candidates.value = [retryIssue]

    await runActorTest(harness, (control) =>
      Effect.gen(function* () {
        yield* releaseWorker(deferred, 'failed')
        yield* awaitSnapshot(control, (snapshot) => snapshot.counts.retrying === 1)
        harness.worker.value = Effect.never
        harness.candidates.value = [occupyingIssue]
        harness.refresh.value = (ids): ReturnType<TrackerAdapter['fetchIssuesByIds']> =>
          Effect.succeed(ids.includes(occupyingIssue.id) ? [occupyingIssue] : [retryIssue])
        yield* control.refresh
        yield* settle(control)
        harness.candidates.value = []
        yield* TestClock.adjust(10_000)
        const snapshot = yield* awaitSnapshot(
          control,
          (candidate) => candidate.retrying[0]?.attempt === 2,
        )
        expect(snapshot.counts).toMatchObject({ running: 1, retrying: 1 })
        expect(snapshot.retrying[0]).toMatchObject({
          attempt: 2,
          error: 'no available orchestrator slots',
        })
      }),
    )
  })
})
