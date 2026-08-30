import { Effect, Fiber, TestClock, TestContext } from 'effect'
import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '../src/codex.js'
import { cyclicIssueIdentifiers, findDependencyCycles } from '../src/dependencies.js'
import { issueId, issueIdentifier, type BlockerRef, type Issue } from '../src/domain.js'
import { AgentError, TrackerError, WorkflowError, WorkspaceError } from '../src/errors.js'
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

const testEnvironment: NodeJS.ProcessEnv = { SYMPHONY_TEST_TOKEN: 'secret' }

const workflow: Workflow = {
  path: '/tmp/WORKFLOW.md',
  fingerprint: 'test',
  promptTemplate: 'test',
  tracker: {
    kind: 'github',
    provider: {
      owner: 'example',
      repository: 'symphony',
      token: 'secret',
      tokenEnvironmentName: 'SYMPHONY_TEST_TOKEN',
      apiBaseUrl: 'https://api.github.com',
      baseBranch: 'main',
    },
  },
  config: {
    tracker: {
      kind: 'github',
      provider: {
        owner: 'example',
        repository: 'symphony',
        token: '$SYMPHONY_TEST_TOKEN',
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
    extensions: {},
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

  it('rejects a provider record marked non-dispatchable at the scheduler boundary', (): void => {
    const issue = {
      ...makeIssue('GH-3', 1, null, ['symphony', 'ready']),
      dispatchable: false,
    }

    expect(issueIsRoutable(issue, workflow)).toBe(false)
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
  idFetchTokens: () => readonly string[]
  trackerWorkflows: () => readonly Workflow[]
  workspaceWorkflows: () => readonly Workflow[]
  agentRuns: () => readonly Readonly<{ command: string; prompt: string; maxTurns: number }>[]
  awaitAgentRun: Effect.Effect<void>
  emitAgentEvent: (event: AgentEvent) => void
}>

const makeHarness = (
  initial: Workflow,
  candidates: (workflow: Workflow) => readonly Issue[] = () => [],
  fetchCandidates?: (
    workflow: Workflow,
    states: readonly string[],
  ) => Effect.Effect<readonly Issue[], never>,
  environment: NodeJS.ProcessEnv = testEnvironment,
): TestHarness => {
  let selected: Workflow | WorkflowError = initial
  let notifyChanged = (): void => undefined
  let loadCount = 0
  let stateFetchCount = 0
  let idFetchCount = 0
  const idFetchTokens: string[] = []
  const trackerWorkflows: Workflow[] = []
  const workspaceWorkflows: Workflow[] = []
  const agentRuns: Readonly<{ command: string; prompt: string; maxTurns: number }>[] = []
  let resolveAgentRun = (): void => undefined
  let onAgentEvent = (_event: AgentEvent): void => undefined
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
        fetchIssuesByStates: (states) => {
          stateFetchCount += 1
          const normalizedStates = new Set(states.map((state) => state.trim().toLowerCase()))
          return (
            fetchCandidates?.(effectiveWorkflow, states) ??
            Effect.succeed(
              candidates(effectiveWorkflow).filter((issue) =>
                normalizedStates.has(issue.state.trim().toLowerCase()),
              ),
            )
          )
        },
        fetchIssuesByIds: () =>
          Effect.sync(() => {
            idFetchCount += 1
            idFetchTokens.push(effectiveWorkflow.tracker.provider.token)
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
        exists: () => Effect.succeed(true),
        beforeRun: () => Effect.void,
        afterRun: () => Effect.void,
        remove: () => Effect.void,
      }
    },
    runAgent: ({ config, prompt, maxTurns, onEvent }) =>
      Effect.sync(() => {
        agentRuns.push({ command: config.command, prompt, maxTurns })
        onAgentEvent = onEvent
        resolveAgentRun()
      }).pipe(Effect.zipRight(Effect.never)),
    environment,
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
    idFetchTokens: () => idFetchTokens,
    trackerWorkflows: () => trackerWorkflows,
    workspaceWorkflows: () => workspaceWorkflows,
    agentRuns: () => agentRuns,
    awaitAgentRun: Effect.promise(() => agentRun),
    emitAgentEvent: (event) => {
      onAgentEvent(event)
    },
  }
}

const runWithTestClock = <Value>(effect: Effect.Effect<Value, WorkflowError>): Promise<Value> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)))

describe('startup terminal workspace cleanup', (): void => {
  it('fetches every terminal state once, cleans every issue, and continues after a cleanup failure', async (): Promise<void> => {
    const startupWorkflow: Workflow = {
      ...workflow,
      config: {
        ...workflow.config,
        tracker: { ...workflow.config.tracker, terminalStates: ['closed', 'cancelled'] },
      },
    }
    const terminalIssues = [
      { ...makeIssue('GH-1', null, null), state: 'closed' },
      { ...makeIssue('GH-2', null, null), state: 'cancelled' },
      { ...makeIssue('GH-3', null, null), state: 'closed' },
    ]
    const harness = makeHarness(startupWorkflow)
    const terminalFetches: Readonly<{
      states: readonly string[]
      labels: readonly string[] | null
      hydrateDependencies: boolean | undefined
    }>[] = []
    const removed: string[] = []
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeTracker: (effectiveWorkflow) => {
        const tracker = harness.dependencies.makeTracker(effectiveWorkflow)
        return {
          ...tracker,
          fetchIssuesByStates: (states, labels, options) => {
            if (!states.includes('open')) {
              terminalFetches.push({
                states,
                labels,
                hydrateDependencies: options?.hydrateDependencies,
              })
            }
            return Effect.succeed(terminalIssues.filter((issue) => states.includes(issue.state)))
          },
          fetchIssuesByIds: (ids, options) => {
            expect(options?.hydrateDependencies).toBe(false)
            return Effect.succeed(terminalIssues.filter((issue) => ids.includes(issue.id)))
          },
        }
      },
      makeWorkspaces: (effectiveWorkflow) => {
        const workspaces = harness.dependencies.makeWorkspaces(effectiveWorkflow)
        return {
          ...workspaces,
          remove: (identifier) =>
            Effect.sync(() => {
              removed.push(identifier)
            }).pipe(
              Effect.flatMap(() =>
                identifier === 'GH-1'
                  ? Effect.fail(
                      new WorkspaceError({
                        category: 'remove_failed',
                        message: 'permission denied',
                      }),
                    )
                  : Effect.void,
              ),
            ),
        }
      },
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* control.snapshot
          yield* control.refresh
          yield* control.snapshot
        }),
      ),
    )

    expect(terminalFetches).toEqual([
      {
        states: ['closed'],
        labels: null,
        hydrateDependencies: false,
      },
      {
        states: ['cancelled'],
        labels: null,
        hydrateDependencies: false,
      },
    ])
    expect(removed).toEqual(['GH-1', 'GH-3', 'GH-2'])
  })

  it('continues startup and dispatch when the terminal fetch fails', async (): Promise<void> => {
    const activeIssue = makeIssue('GH-4', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [activeIssue])
    let startupFetch = true
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeTracker: (effectiveWorkflow) => {
        const tracker = harness.dependencies.makeTracker(effectiveWorkflow)
        return {
          ...tracker,
          fetchIssuesByStates: (states, labels) => {
            if (startupFetch) {
              startupFetch = false
              return Effect.fail(
                new TrackerError({
                  category: 'tracker_request',
                  message: 'tracker unavailable',
                  retryable: true,
                }),
              )
            }
            return tracker.fetchIssuesByStates(states, labels)
          },
        }
      },
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* harness.awaitAgentRun
        }),
      ),
    )

    expect(harness.agentRuns()).toHaveLength(1)
  })

  it('preserves successful cleanup results when another terminal state fetch fails', async (): Promise<void> => {
    const startupWorkflow: Workflow = {
      ...workflow,
      config: {
        ...workflow.config,
        tracker: { ...workflow.config.tracker, terminalStates: ['closed', 'cancelled'] },
      },
    }
    const closedIssue = { ...makeIssue('GH-9', null, null), state: 'closed' }
    const harness = makeHarness(startupWorkflow)
    const removed: string[] = []
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeTracker: (effectiveWorkflow) => ({
        ...harness.dependencies.makeTracker(effectiveWorkflow),
        fetchIssuesByStates: (states) =>
          states.includes('cancelled')
            ? Effect.fail(
                new TrackerError({
                  category: 'tracker_request',
                  message: 'unsupported state',
                  retryable: false,
                }),
              )
            : Effect.succeed([closedIssue]),
        fetchIssuesByIds: () => Effect.succeed([closedIssue]),
      }),
      makeWorkspaces: (effectiveWorkflow) => ({
        ...harness.dependencies.makeWorkspaces(effectiveWorkflow),
        remove: (identifier) => Effect.sync(() => removed.push(identifier)).pipe(Effect.asVoid),
      }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* control.snapshot
        }),
      ),
    )

    expect(removed).toEqual(['GH-9'])
  })

  it('does not dispatch until the startup sweep completes', async (): Promise<void> => {
    const terminalIssue = { ...makeIssue('GH-5', null, null), state: 'closed' }
    const activeIssue = makeIssue('GH-6', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [activeIssue])
    let resolveCleanup = (): void => undefined
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve
    })
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeTracker: (effectiveWorkflow) => {
        const tracker = harness.dependencies.makeTracker(effectiveWorkflow)
        return {
          ...tracker,
          fetchIssuesByStates: (states, labels) =>
            states.includes('closed')
              ? Effect.succeed([terminalIssue])
              : tracker.fetchIssuesByStates(states, labels),
          fetchIssuesByIds: () => Effect.succeed([terminalIssue]),
        }
      },
      makeWorkspaces: (effectiveWorkflow) => {
        const workspaces = harness.dependencies.makeWorkspaces(effectiveWorkflow)
        return { ...workspaces, remove: () => Effect.promise(() => cleanup) }
      },
    }

    const running = runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* harness.awaitAgentRun
        }),
      ),
    )
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    expect(harness.agentRuns()).toEqual([])

    resolveCleanup()
    await running
    expect(harness.agentRuns()).toHaveLength(1)
  })

  it('preserves the workspace when an issue reopens during startup cleanup', async (): Promise<void> => {
    const terminalIssue = { ...makeIssue('GH-7', null, null), state: 'closed' }
    const reopenedIssue = { ...terminalIssue, state: 'open' }
    const harness = makeHarness(workflow)
    const removed: string[] = []
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeTracker: (effectiveWorkflow) => ({
        ...harness.dependencies.makeTracker(effectiveWorkflow),
        fetchIssuesByStates: () => Effect.succeed([terminalIssue]),
        fetchIssuesByIds: (_ids, options) => {
          expect(options?.hydrateDependencies).toBe(false)
          return Effect.succeed([reopenedIssue])
        },
      }),
      makeWorkspaces: (effectiveWorkflow) => ({
        ...harness.dependencies.makeWorkspaces(effectiveWorkflow),
        remove: (identifier) => Effect.sync(() => removed.push(identifier)).pipe(Effect.asVoid),
      }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* control.snapshot
        }),
      ),
    )

    expect(removed).toEqual([])
  })

  it('does not refresh terminal issues without retained workspaces', async (): Promise<void> => {
    const terminalIssue = { ...makeIssue('GH-8', null, null), state: 'closed' }
    const harness = makeHarness(workflow)
    let idFetches = 0
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeTracker: (effectiveWorkflow) => ({
        ...harness.dependencies.makeTracker(effectiveWorkflow),
        fetchIssuesByStates: () => Effect.succeed([terminalIssue]),
        fetchIssuesByIds: () => {
          idFetches += 1
          return Effect.succeed([terminalIssue])
        },
      }),
      makeWorkspaces: (effectiveWorkflow) => ({
        ...harness.dependencies.makeWorkspaces(effectiveWorkflow),
        exists: () => Effect.succeed(false),
      }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* control.snapshot
        }),
      ),
    )

    expect(idFetches).toBe(0)
  })
})

const awaitLoads = (harness: TestHarness, expected: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (harness.loads() < expected) {
      yield* Effect.yieldNow()
    }
  })

describe('operator snapshots', (): void => {
  it('start and remain responsive while the initial tracker poll is pending', async (): Promise<void> => {
    let markPollStarted = (): void => undefined
    const pollStarted = new Promise<void>((resolve) => {
      markPollStarted = resolve
    })
    const harness = makeHarness(
      workflow,
      () => [],
      (_effectiveWorkflow, states) => {
        if (!states.includes('open')) {
          return Effect.succeed([])
        }
        markPollStarted()
        return Effect.never
      },
    )

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* Effect.promise(() => pollStarted)
          return yield* control.snapshot
        }),
      ),
    )

    expect(snapshot.effectiveWorkflow.fingerprint).toBe('test')
  })

  it('runs one follow-up poll for a refresh received during a pending poll', async (): Promise<void> => {
    let pollShouldBlock = false
    let markPollStarted = (): void => undefined
    let releasePoll = (): void => undefined
    const pollStarted = new Promise<void>((resolve) => {
      markPollStarted = resolve
    })
    const pollReleased = new Promise<void>((resolve) => {
      releasePoll = resolve
    })
    const initial = changedWorkflow({ fingerprint: 'initial' })
    const reloaded = changedWorkflow({ fingerprint: 'late-refresh' })
    const harness = makeHarness(
      initial,
      () => [],
      (_effectiveWorkflow, states) => {
        if (!states.includes('open')) {
          return Effect.succeed([])
        }
        if (pollShouldBlock) {
          markPollStarted()
          return Effect.promise(() => pollReleased).pipe(Effect.as([]))
        }
        return Effect.succeed([])
      },
    )

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* control.refresh
          pollShouldBlock = true
          yield* Effect.forkScoped(control.refresh)
          yield* Effect.promise(() => pollStarted)
          harness.setWorkflow(reloaded)
          const lateRefresh = yield* Effect.forkScoped(control.refresh)
          pollShouldBlock = false
          releasePoll()
          yield* Fiber.join(lateRefresh)
          return yield* control.snapshot
        }),
      ),
    )

    expect(snapshot.effectiveWorkflow.fingerprint).toBe('late-refresh')
  })

  it('preserves a refresh started while the previous refresh is settling', async (): Promise<void> => {
    const harness = makeHarness(workflow)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* control.refresh
          const before = harness.stateFetches()
          const consecutiveRefreshes = yield* Effect.forkScoped(
            control.refresh.pipe(Effect.zipRight(control.refresh)),
          )
          yield* Fiber.join(consecutiveRefreshes)
          expect(harness.stateFetches()).toBe(before + 2)
        }),
      ),
    )
  })
})

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
          yield* control.refresh
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
          yield* control.refresh
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

  it('keeps invalid reloads visible while reconciling and dispatching with the valid workflow', async (): Promise<void> => {
    const issue = makeIssue('GH-1', 1, null, ['symphony', 'ready'])
    const initial = changedWorkflow({ fingerprint: 'last-known-good' })
    const harness = makeHarness(initial, () => [issue])

    const snapshot = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* control.refresh
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
    expect(harness.stateFetches()).toBeGreaterThan(1)
  })

  it('defensively reloads after a missed watch event', async (): Promise<void> => {
    const initial = changedWorkflow({ fingerprint: 'initial', pollingIntervalMs: 1_000 })
    const harness = makeHarness(initial)

    const snapshot = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* control.refresh
          harness.setWorkflow(
            changedWorkflow({ fingerprint: 'missed-event', pollingIntervalMs: 2_000 }),
          )
          const beforeTick = harness.loads()
          yield* TestClock.adjust(1_000)
          yield* awaitLoads(harness, beforeTick + 1)
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
          yield* control.refresh
          harness.setWorkflow(changedWorkflow({ fingerprint: 'slower', pollingIntervalMs: 5_000 }))
          yield* control.refresh
          yield* control.snapshot
          const afterReload = harness.loads()

          yield* TestClock.adjust(4_999)
          yield* control.snapshot
          expect(harness.loads()).toBe(afterReload)

          yield* TestClock.adjust(1)
          yield* awaitLoads(harness, afterReload + 1)
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
          yield* control.refresh
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

  it('uses the provider returned by dispatch preflight', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#1', 1, null, ['symphony', 'ready'])
    const environment: NodeJS.ProcessEnv = { SYMPHONY_TEST_TOKEN: 'secret' }
    const harness = makeHarness(
      workflow,
      () => [],
      () => {
        environment['SYMPHONY_TEST_TOKEN'] = 'rotated'
        return Effect.succeed([issue])
      },
      environment,
    )

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* harness.awaitAgentRun
        }),
      ),
    )

    expect(harness.trackerWorkflows().at(-1)?.tracker.provider.token).toBe('rotated')
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

describe('tracker credential revalidation', (): void => {
  it('updates the tracker used by an active worker issue refresh', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#1', 1, null, ['symphony', 'ready'])
    const environment: NodeJS.ProcessEnv = { SYMPHONY_TEST_TOKEN: 'secret' }
    const harness = makeHarness(workflow, () => [issue])
    let refreshIssue: Parameters<OrchestratorDependencies['runAgent']>[0]['refreshIssue'] | null =
      null
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      environment,
      runAgent: (launch) => {
        refreshIssue = launch.refreshIssue
        return harness.dependencies.runAgent(launch)
      },
    }
    const refreshActiveIssue = (): Effect.Effect<void> =>
      refreshIssue === null
        ? Effect.die('worker did not provide an issue refresh callback')
        : refreshIssue().pipe(Effect.asVoid, Effect.orDie)

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* harness.awaitAgentRun
          environment['SYMPHONY_TEST_TOKEN'] = 'rotated'
          yield* control.refresh
          yield* refreshActiveIssue()
        }),
      ),
    )

    expect(harness.idFetchTokens().at(-1)).toBe('rotated')
  })

  it('rebuilds the tracker when the referenced secret is rotated in the environment', async (): Promise<void> => {
    const environment: NodeJS.ProcessEnv = { SYMPHONY_TEST_TOKEN: 'first' }
    const harness = makeHarness(workflow)

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.dependencies,
            environment,
          })
          yield* control.refresh
          environment['SYMPHONY_TEST_TOKEN'] = 'rotated'
          yield* control.refresh
        }),
      ),
    )

    expect(harness.trackerWorkflows().map((each) => each.tracker.provider.token)).toEqual([
      'secret',
      'first',
      'rotated',
    ])
  })

  it('retains the last known good tracker when the secret disappears', async (): Promise<void> => {
    const environment: NodeJS.ProcessEnv = { SYMPHONY_TEST_TOKEN: 'first' }
    const harness = makeHarness(workflow)

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.dependencies,
            environment,
          })
          yield* control.refresh
          delete environment['SYMPHONY_TEST_TOKEN']
          yield* control.refresh
        }),
      ),
    )

    expect(harness.trackerWorkflows().map((each) => each.tracker.provider.token)).toEqual([
      'secret',
      'first',
    ])
  })
})

describe('scheduler dependency hydration', (): void => {
  it('requests hydration for every candidate when no labels are required', async (): Promise<void> => {
    const unlabeled: Workflow = {
      ...workflow,
      config: {
        ...workflow.config,
        tracker: { ...workflow.config.tracker, requiredLabels: [] },
      },
    }
    const requested: (readonly string[] | null)[] = []
    const harness = makeHarness(unlabeled)
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeTracker: (effectiveWorkflow) => ({
        ...harness.dependencies.makeTracker(effectiveWorkflow),
        fetchIssuesByStates: (_states, dependencyLabels) => {
          requested.push(dependencyLabels)
          return Effect.succeed([])
        },
      }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* control.refresh
        }),
      ),
    )

    expect(requested).toContain(null)
    expect(requested).not.toContainEqual([])
  })

  it('passes the configured labels through when some are required', async (): Promise<void> => {
    const requested: (readonly string[] | null)[] = []
    const harness = makeHarness(workflow)
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeTracker: (effectiveWorkflow) => ({
        ...harness.dependencies.makeTracker(effectiveWorkflow),
        fetchIssuesByStates: (_states, dependencyLabels) => {
          requested.push(dependencyLabels)
          return Effect.succeed([])
        },
      }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* control.refresh
        }),
      ),
    )

    expect(requested).toContainEqual(['symphony', 'ready'])
  })
})

const makeAgentEvent = (overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  event: 'thread/tokenUsage/updated',
  timestamp: new Date(),
  processId: 123,
  message: 'working',
  threadId: 'thread-1',
  turnId: 'turn-1',
  sessionId: 'thread-1',
  turnCount: 1,
  turnStatus: null,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  rateLimits: null,
  ...overrides,
})

describe('session telemetry accounting', (): void => {
  it('tracks metadata and rate limits without double-counting repeated absolute totals', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#16', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
          yield* harness.awaitAgentRun
          harness.emitAgentEvent(makeAgentEvent({ event: 'session_started', usage: null }))
          harness.emitAgentEvent(makeAgentEvent())
          harness.emitAgentEvent(makeAgentEvent())
          harness.emitAgentEvent(
            makeAgentEvent({
              usage: { inputTokens: 14, outputTokens: 7, totalTokens: 21 },
              rateLimits: {
                limitId: 'codex',
                credits: { hasCredits: true, balance: '20' },
                primary: { usedPercent: 25, windowDurationMins: 300 },
              },
            }),
          )
          harness.emitAgentEvent(
            makeAgentEvent({ event: 'item/completed', message: 'meaningful update', usage: null }),
          )
          harness.emitAgentEvent(
            makeAgentEvent({
              event: 'account/rateLimits/updated',
              message: null,
              usage: null,
              rateLimits: {
                secondary: { usedPercent: 5, windowDurationMins: 1_440 },
              },
            }),
          )
          harness.emitAgentEvent(
            makeAgentEvent({
              event: 'account/rateLimits/updated',
              message: null,
              usage: null,
              rateLimits: { credits: { balance: null } },
            }),
          )
          harness.emitAgentEvent(
            makeAgentEvent({
              event: 'turn_started',
              turnId: 'turn-2',
              turnCount: 2,
              message: null,
              usage: null,
            }),
          )
          harness.emitAgentEvent(
            makeAgentEvent({
              event: 'turn/usage',
              turnId: 'turn-1',
              turnCount: 1,
              message: null,
              usage: null,
            }),
          )
          harness.emitAgentEvent(
            makeAgentEvent({
              event: 'turn/terminated',
              turnId: 'turn-2',
              turnCount: 2,
              message: null,
              turnStatus: 'timed_out',
              usage: null,
            }),
          )
          yield* Effect.yieldNow()
          yield* Effect.yieldNow()

          const live = yield* control.snapshot
          expect(live.running[0]).toMatchObject({
            threadId: 'thread-1',
            turnId: 'turn-2',
            sessionId: 'thread-1',
            turnCount: 2,
            processId: 123,
            lastMessage: 'meaningful update',
            tokens: { inputTokens: 14, outputTokens: 7, totalTokens: 21 },
          })
          expect(live.totals).toMatchObject({ inputTokens: 14, outputTokens: 7, totalTokens: 21 })
          expect(live.rateLimits).toMatchObject({
            limitId: 'codex',
            credits: { hasCredits: true, balance: null },
            primary: { usedPercent: 25, windowDurationMins: 300 },
            secondary: { usedPercent: 5, windowDurationMins: 1_440 },
          })

          yield* control.setIssuePaused(16, true)
          const cancelled = yield* control.snapshot
          expect(cancelled.running).toEqual([])
          expect(cancelled.totals).toMatchObject({
            inputTokens: 14,
            outputTokens: 7,
            totalTokens: 21,
          })
        }),
      ),
    )
  })

  it('cancels a stalled worker and schedules its first retry', async (): Promise<void> => {
    const stalledWorkflow: Workflow = {
      ...workflow,
      config: {
        ...workflow.config,
        codex: { ...workflow.config.codex, stallTimeoutMs: 1 },
      },
    }
    const issue = makeIssue('example/symphony#19', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(stalledWorkflow, () => [issue])
    let resolveStarted = (): void => undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let interrupted = false
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      runAgent: ({ onEvent }) =>
        Effect.sync(() => {
          onEvent(makeAgentEvent({ timestamp: new Date(0), message: 'last progress' }))
          resolveStarted()
        }).pipe(
          Effect.zipRight(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
            }),
          ),
        ),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* Effect.promise(() => started)
          yield* Effect.yieldNow()
          yield* Effect.yieldNow()

          yield* control.refresh

          const snapshot = yield* control.snapshot
          expect(interrupted).toBe(true)
          expect(snapshot.running).toEqual([])
          expect(snapshot.retrying).toHaveLength(1)
          expect(snapshot.retrying[0]).toMatchObject({
            issueId: issue.id,
            identifier: issue.identifier,
            attempt: 1,
            error: 'agent stalled',
          })
          expect(Date.parse(snapshot.retrying[0]?.dueAt ?? '')).not.toBeNaN()
        }),
      ),
    )
  })

  it('does not launch the agent when beforeRun fails', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#24', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    let agentLaunches = 0
    let afterRunCount = 0
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeWorkspaces: (effectiveWorkflow) => ({
        ...harness.dependencies.makeWorkspaces(effectiveWorkflow),
        beforeRun: () =>
          Effect.fail(
            new WorkspaceError({ category: 'hook_failed', message: 'before_run rejected' }),
          ),
        afterRun: () =>
          Effect.sync(() => {
            afterRunCount += 1
          }),
      }),
      runAgent: () =>
        Effect.sync(() => {
          agentLaunches += 1
          return { threadId: 'unexpected', turnId: 'unexpected', turnCount: 1 }
        }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          let snapshot = yield* control.snapshot
          while (snapshot.retrying.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          expect(agentLaunches).toBe(0)
          expect(afterRunCount).toBe(1)
          expect(snapshot.running).toEqual([])
          expect(snapshot.retrying[0]).toMatchObject({
            issueId: issue.id,
            attempt: 1,
            error: 'before_run rejected',
          })
        }),
      ),
    )
  })

  it('schedules continuation attempt one after a normal exit without a branch', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#23', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    let handoffCount = 0
    let afterRunCount = 0
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeWorkspaces: (effectiveWorkflow) => ({
        ...harness.dependencies.makeWorkspaces(effectiveWorkflow),
        afterRun: () =>
          Effect.sync(() => {
            afterRunCount += 1
          }),
      }),
      makeTracker: (effectiveWorkflow) => ({
        ...harness.dependencies.makeTracker(effectiveWorkflow),
        handoffCompletedWork: () =>
          Effect.sync(() => {
            handoffCount += 1
            return { _tag: 'NoBranch' as const, branchName: 'symphony/test' }
          }),
      }),
      runAgent: () =>
        Effect.succeed({ threadId: 'thread-normal', turnId: 'turn-normal', turnCount: 1 }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          let snapshot = yield* control.snapshot
          while (snapshot.retrying.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          expect(handoffCount).toBe(1)
          expect(afterRunCount).toBe(1)
          expect(snapshot.running).toEqual([])
          expect(snapshot.retrying).toHaveLength(1)
          expect(snapshot.retrying[0]).toMatchObject({
            issueId: issue.id,
            attempt: 1,
            error: null,
          })
        }),
      ),
    )
  })

  it('interrupts a non-active refreshed issue without removing its workspace', async (): Promise<void> => {
    let currentIssue = makeIssue('example/symphony#20', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [currentIssue])
    let resolveStarted = (): void => undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let interrupted = false
    const removed: string[] = []
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeWorkspaces: (effectiveWorkflow) => ({
        ...harness.dependencies.makeWorkspaces(effectiveWorkflow),
        remove: (identifier) => Effect.sync(() => removed.push(identifier)).pipe(Effect.asVoid),
      }),
      runAgent: () =>
        Effect.sync(resolveStarted).pipe(
          Effect.zipRight(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
            }),
          ),
        ),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* Effect.promise(() => started)
          currentIssue = { ...currentIssue, state: 'review' }

          yield* control.refresh

          const snapshot = yield* control.snapshot
          expect(interrupted).toBe(true)
          expect(snapshot.running).toEqual([])
          expect(snapshot.retrying).toEqual([])
          expect(removed).toEqual([])
        }),
      ),
    )
  })

  it('updates running snapshot metadata when an active issue refreshes', async (): Promise<void> => {
    let currentIssue = makeIssue('example/symphony#25', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [currentIssue])
    let resolveStarted = (): void => undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      runAgent: () => Effect.sync(resolveStarted).pipe(Effect.zipRight(Effect.never)),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* Effect.promise(() => started)
          currentIssue = { ...currentIssue, title: 'Updated while active' }

          yield* control.refresh

          const snapshot = yield* control.snapshot
          expect(snapshot.running).toHaveLength(1)
          expect(snapshot.running[0]).toMatchObject({
            issueId: currentIssue.id,
            title: 'Updated while active',
          })
        }),
      ),
    )
  })

  it('applies a configured retry cap to an actual failed worker', async (): Promise<void> => {
    const cappedWorkflow: Workflow = {
      ...workflow,
      config: {
        ...workflow.config,
        agent: { ...workflow.config.agent, maxRetryBackoffMs: 250 },
      },
    }
    const issue = makeIssue('example/symphony#26', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(cappedWorkflow, () => [issue])
    let failureAt = 0
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      runAgent: () =>
        Effect.sync(() => {
          failureAt = Date.now()
        }).pipe(
          Effect.zipRight(
            Effect.fail(new AgentError({ category: 'process_exited', message: 'test failure' })),
          ),
        ),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          let snapshot = yield* control.snapshot
          while (snapshot.retrying.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          expect(snapshot.retrying[0]).toMatchObject({ issueId: issue.id, attempt: 1 })
          const scheduledDelay = Date.parse(snapshot.retrying[0]?.dueAt ?? '') - failureAt
          expect(scheduledDelay).toBeGreaterThanOrEqual(250)
          expect(scheduledDelay).toBeLessThan(1_000)
        }),
      ),
    )
  })

  it('requeues a due retry when another worker occupies the only slot', async (): Promise<void> => {
    const retryingIssue = makeIssue('example/symphony#21', 1, null, ['symphony', 'ready'])
    const occupyingIssue = makeIssue('example/symphony#22', 1, null, ['symphony', 'ready'])
    let candidates: readonly Issue[] = [retryingIssue]
    const harness = makeHarness(workflow, () => candidates)
    let resolveOccupyingStarted = (): void => undefined
    const occupyingStarted = new Promise<void>((resolve) => {
      resolveOccupyingStarted = resolve
    })
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeTracker: (effectiveWorkflow) => ({
        ...harness.dependencies.makeTracker(effectiveWorkflow),
        fetchIssuesByIds: (ids) =>
          Effect.succeed([retryingIssue, occupyingIssue].filter((issue) => ids.includes(issue.id))),
      }),
      runAgent: ({ issue }) => {
        if (issue.id === retryingIssue.id) {
          return Effect.fail(
            new AgentError({ category: 'process_exited', message: 'retrying worker failed' }),
          )
        }
        return Effect.sync(resolveOccupyingStarted).pipe(Effect.zipRight(Effect.never))
      },
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          while ((yield* control.snapshot).retrying.length === 0) {
            yield* Effect.yieldNow()
          }

          candidates = [occupyingIssue]
          yield* control.refresh
          yield* Effect.promise(() => occupyingStarted)
          yield* TestClock.adjust(10_000)
          yield* Effect.yieldNow()

          const snapshot = yield* control.snapshot
          expect(snapshot.running).toHaveLength(1)
          expect(snapshot.running[0]?.issueId).toBe(occupyingIssue.id)
          expect(snapshot.retrying).toHaveLength(1)
          expect(snapshot.retrying[0]).toMatchObject({
            issueId: retryingIssue.id,
            attempt: 2,
            error: 'no available orchestrator slots',
          })
        }),
      ),
    )
  })

  it('retains ended usage while a retry starts a fresh absolute counter', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#17', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    let runCount = 0
    let resolveSecondRun = (): void => undefined
    const secondRun = new Promise<void>((resolve) => {
      resolveSecondRun = resolve
    })
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      runAgent: ({ onEvent }) =>
        Effect.suspend(() => {
          runCount += 1
          onEvent(
            makeAgentEvent({
              threadId: `thread-${String(runCount)}`,
              sessionId: `thread-${String(runCount)}`,
              usage:
                runCount === 1
                  ? { inputTokens: 8, outputTokens: 2, totalTokens: 10 }
                  : { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
            }),
          )
          if (runCount === 1) {
            return Effect.fail(
              new AgentError({ category: 'process_exited', message: 'test process exited' }),
            )
          }
          resolveSecondRun()
          return Effect.never
        }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          while (runCount < 1) {
            yield* Effect.yieldNow()
          }
          yield* Effect.yieldNow()
          const retrying = yield* control.snapshot
          expect(retrying.totals).toMatchObject({
            inputTokens: 8,
            outputTokens: 2,
            totalTokens: 10,
          })
          expect(retrying.retrying[0]?.attempt).toBe(1)

          yield* TestClock.adjust(10_000)
          yield* Effect.promise(() => secondRun)
          yield* Effect.yieldNow()
          const retried = yield* control.snapshot
          expect(retried.totals).toMatchObject({
            inputTokens: 12,
            outputTokens: 3,
            totalTokens: 15,
          })
        }),
      ),
    )
  })
})
