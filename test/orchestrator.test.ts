import { Effect, TestClock, TestContext } from 'effect'
import { describe, expect, it } from 'vitest'

import { cyclicIssueIdentifiers, findDependencyCycles } from '../src/dependencies.js'
import { issueId, issueIdentifier, type BlockerRef, type Issue } from '../src/domain.js'
import { WorkflowError } from '../src/errors.js'
import {
  issueIsRoutable,
  retryDelayMs,
  sortIssues,
  startOrchestrator,
  type OrchestratorDependencies,
} from '../src/orchestrator.js'
import type { TrackerAdapter } from '../src/tracker.js'
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
  frontMatter: {},
  promptTemplate: 'test',
  config: {
    tracker: {
      kind: 'github',
      provider: {
        owner: 'example',
        repository: 'symphony',
        token: 'secret',
        tokenEnvironmentName: 'GITHUB_TOKEN',
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
      turnSandboxPolicy: null,
      turnTimeoutMs: 60_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 30_000,
    },
    serverPort: null,
  },
}

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

const changedWorkflow = (overrides: {
  fingerprint: string
  pollingIntervalMs?: number
  maxConcurrentAgents?: number
  promptTemplate?: string
}): Workflow => ({
  ...workflow,
  fingerprint: overrides.fingerprint,
  promptTemplate: overrides.promptTemplate ?? workflow.promptTemplate,
  config: {
    ...workflow.config,
    pollingIntervalMs: overrides.pollingIntervalMs ?? workflow.config.pollingIntervalMs,
    agent: {
      ...workflow.config.agent,
      maxConcurrentAgents:
        overrides.maxConcurrentAgents ?? workflow.config.agent.maxConcurrentAgents,
    },
  },
})

type TestHarness = Readonly<{
  dependencies: OrchestratorDependencies
  setWorkflow: (workflow: Workflow | WorkflowError) => void
  notifyChanged: () => void
  loads: () => number
  stateFetches: () => number
  idFetches: () => number
  trackerWorkflows: () => readonly Workflow[]
  workspaceWorkflows: () => readonly Workflow[]
  agentRuns: () => readonly Readonly<{ command: string; prompt: string; maxTurns: number }>[]
  awaitAgentRun: Effect.Effect<void>
}>

const makeHarness = (
  initial: Workflow,
  candidates: (workflow: Workflow) => readonly Issue[] = () => [],
): TestHarness => {
  let selected: Workflow | WorkflowError = initial
  let notifyChanged = (): void => undefined
  let loadCount = 0
  let stateFetchCount = 0
  let idFetchCount = 0
  const trackerWorkflows: Workflow[] = []
  const workspaceWorkflows: Workflow[] = []
  const agentRuns: Readonly<{ command: string; prompt: string; maxTurns: number }>[] = []
  let resolveAgentRun = (): void => undefined
  const agentRun = new Promise<void>((resolve) => {
    resolveAgentRun = resolve
  })

  const dependencies: OrchestratorDependencies = {
    loadWorkflow: () => {
      loadCount += 1
      return selected instanceof WorkflowError ? Effect.fail(selected) : Effect.succeed(selected)
    },
    makeTracker: (effectiveWorkflow): TrackerAdapter => {
      trackerWorkflows.push(effectiveWorkflow)
      return {
        fetchIssuesByStates: () =>
          Effect.sync(() => {
            stateFetchCount += 1
            return candidates(effectiveWorkflow)
          }),
        fetchIssuesByIds: () =>
          Effect.sync(() => {
            idFetchCount += 1
            return candidates(effectiveWorkflow)
          }),
        handoffCompletedWork: () =>
          Effect.succeed({ _tag: 'NoBranch', branchName: 'symphony/test' }),
        inspectPullRequest: () => Effect.die('unused'),
        mergePullRequest: () => Effect.die('unused'),
        resolveReviewThreads: () => Effect.die('unused'),
        secretEnvironmentNames: [],
      }
    },
    makeWorkspaces: (effectiveWorkflow) => {
      workspaceWorkflows.push(effectiveWorkflow)
      return {
        create: () =>
          Effect.succeed({ path: '/tmp/symphony-test', key: 'test', createdNow: false }),
        beforeRun: () => Effect.void,
        afterRun: () => Effect.void,
        remove: () => Effect.void,
      }
    },
    runAgent: (_issue, _workspace, config, prompt, maxTurns) =>
      Effect.sync(() => {
        agentRuns.push({ command: config.command, prompt, maxTurns })
        resolveAgentRun()
      }).pipe(Effect.zipRight(Effect.never)),
    watchWorkflow: (_path, onChange) => {
      notifyChanged = onChange
      return { close: () => Promise.resolve() }
    },
  }

  return {
    dependencies,
    setWorkflow: (next) => {
      selected = next
    },
    notifyChanged: () => {
      notifyChanged()
    },
    loads: () => loadCount,
    stateFetches: () => stateFetchCount,
    idFetches: () => idFetchCount,
    trackerWorkflows: () => trackerWorkflows,
    workspaceWorkflows: () => workspaceWorkflows,
    agentRuns: () => agentRuns,
    awaitAgentRun: Effect.promise(() => agentRun),
  }
}

const runWithTestClock = <Value>(effect: Effect.Effect<Value, WorkflowError>): Promise<Value> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)))

describe('workflow hot reload', (): void => {
  it('replaces the last known good workflow after a valid defensive reload', async (): Promise<void> => {
    const initial = changedWorkflow({ fingerprint: 'initial', pollingIntervalMs: 1_000 })
    const reloaded = changedWorkflow({
      fingerprint: 'reloaded',
      pollingIntervalMs: 5_000,
      maxConcurrentAgents: 4,
    })
    const harness = makeHarness(initial)

    const snapshot = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* control.snapshot
          harness.setWorkflow(reloaded)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(snapshot.effectiveWorkflow.fingerprint).toBe('reloaded')
    expect(snapshot.pollingIntervalMs).toBe(5_000)
    expect(snapshot.maxConcurrentAgents).toBe(4)
    expect(snapshot.workflowReloadError).toBeNull()
  })

  it('uses all reloaded settings for future operations', async (): Promise<void> => {
    const initial = changedWorkflow({ fingerprint: 'initial' })
    const reloaded: Workflow = {
      ...changedWorkflow({
        fingerprint: 'all-settings',
        maxConcurrentAgents: 3,
        promptTemplate: 'Reloaded {{ issue.identifier }}',
      }),
      config: {
        ...workflow.config,
        tracker: {
          ...workflow.config.tracker,
          provider: { ...workflow.config.tracker.provider, repository: 'reloaded-repository' },
          activeStates: ['open', 'queued'],
        },
        pollingIntervalMs: 7_000,
        workspaceRoot: '/tmp/reloaded-workspaces',
        hooks: { ...workflow.config.hooks, beforeRun: 'echo reloaded' },
        agent: {
          ...workflow.config.agent,
          maxConcurrentAgents: 3,
          maxRetryBackoffMs: 12_000,
          maxTurns: 9,
        },
        codex: { ...workflow.config.codex, command: 'reloaded-codex app-server' },
      },
    }
    const issue = makeIssue('GH-9', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(initial, (effective) =>
      effective.fingerprint === reloaded.fingerprint ? [issue] : [],
    )

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* control.snapshot
          harness.setWorkflow(reloaded)
          yield* control.refresh
          yield* control.snapshot
          yield* harness.awaitAgentRun
        }),
      ),
    )

    expect(harness.trackerWorkflows().at(-1)?.config.tracker.provider['repository']).toBe(
      'reloaded-repository',
    )
    expect(harness.trackerWorkflows().at(-1)?.config.tracker.activeStates).toEqual([
      'open',
      'queued',
    ])
    expect(harness.trackerWorkflows().at(-1)?.config.pollingIntervalMs).toBe(7_000)
    expect(harness.trackerWorkflows().at(-1)?.config.agent.maxConcurrentAgents).toBe(3)
    expect(harness.trackerWorkflows().at(-1)?.config.agent.maxRetryBackoffMs).toBe(12_000)
    expect(harness.workspaceWorkflows().at(-1)?.config.workspaceRoot).toBe(
      '/tmp/reloaded-workspaces',
    )
    expect(harness.workspaceWorkflows().at(-1)?.config.hooks.beforeRun).toBe('echo reloaded')
    expect(harness.agentRuns()).toEqual([
      {
        command: 'reloaded-codex app-server',
        prompt: 'Reloaded GH-9',
        maxTurns: 9,
      },
    ])
  })

  it('keeps invalid reloads visible while reconciling and skipping new dispatch preflight', async (): Promise<void> => {
    const issue = makeIssue('GH-1', 1, null, ['symphony', 'ready'])
    const initial = changedWorkflow({ fingerprint: 'last-known-good' })
    const harness = makeHarness(initial, () => [issue])

    const snapshot = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* control.snapshot
          harness.setWorkflow(
            new WorkflowError({ category: 'invalid_config', message: 'invalid reload' }),
          )
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(snapshot.effectiveWorkflow.fingerprint).toBe('last-known-good')
    expect(snapshot.workflowReloadError?.message).toBe('invalid reload')
    expect(harness.idFetches()).toBeGreaterThan(0)
    expect(harness.stateFetches()).toBe(1)
  })

  it('defensively reloads after a missed watch event', async (): Promise<void> => {
    const initial = changedWorkflow({ fingerprint: 'initial', pollingIntervalMs: 1_000 })
    const harness = makeHarness(initial)

    const snapshot = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* control.snapshot
          harness.setWorkflow(
            changedWorkflow({ fingerprint: 'missed-event', pollingIntervalMs: 2_000 }),
          )
          yield* TestClock.adjust(1_000)
          return yield* control.snapshot
        }),
      ),
    )

    expect(snapshot.effectiveWorkflow.fingerprint).toBe('missed-event')
  })

  it('re-arms future ticks with a changed polling interval', async (): Promise<void> => {
    const initial = changedWorkflow({ fingerprint: 'initial', pollingIntervalMs: 1_000 })
    const harness = makeHarness(initial)

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* control.snapshot
          harness.setWorkflow(changedWorkflow({ fingerprint: 'slower', pollingIntervalMs: 5_000 }))
          yield* control.refresh
          yield* control.snapshot
          const afterReload = harness.loads()

          yield* TestClock.adjust(4_999)
          yield* control.snapshot
          expect(harness.loads()).toBe(afterReload)

          yield* TestClock.adjust(1)
          yield* control.snapshot
          expect(harness.loads()).toBe(afterReload + 1)
        }),
      ),
    )
  })

  it('coalesces watcher and defensive reload requests', async (): Promise<void> => {
    const harness = makeHarness(changedWorkflow({ fingerprint: 'initial' }))

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* control.snapshot
          const before = harness.loads()
          yield* control.refresh
          harness.notifyChanged()
          yield* Effect.yieldNow()
          yield* control.snapshot
          expect(harness.loads()).toBe(before + 1)
        }),
      ),
    )
  })

  it('cancels a running worker when the operator explicitly pauses its issue', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#1', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(changedWorkflow({ fingerprint: 'initial' }), () => [issue])

    const snapshot = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* harness.awaitAgentRun
          yield* control.setIssuePaused(1, true)
          return yield* control.snapshot
        }),
      ),
    )

    expect(snapshot.counts.running).toBe(0)
  })
})
