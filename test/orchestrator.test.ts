import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Scope,
  Stream,
  TestClock,
  TestContext,
} from 'effect'
import { describe, expect, it } from 'vitest'

import { codexAgentEventSemantics } from '../src/adapters/codex/agent-runner.js'
import { githubProviderOf, githubTrackerProvider } from '../src/adapters/github/index.js'
import { telemetryFrom, type AgentEvent, type AgentResult } from '../src/adapters/codex/codex.js'
import { cyclicIssueIdentifiers, findDependencyCycles } from '../src/domain/dependencies.js'
import {
  issueId,
  issueIdentifier,
  type BlockerRef,
  type Issue,
  type JsonObject,
} from '../src/domain/domain.js'
import { AgentError, TrackerError, WorkflowError, WorkspaceError } from '../src/errors.js'
import { loadHandoffs, saveHandoffs } from '../src/handoff-store.js'
import type { CodexReviewObservation } from '../src/domain/handoff.js'
import {
  issueIsRoutable,
  retainedCompletedDetails,
  retryDelayMs,
  sortIssues,
  startOrchestrator,
  type AgentDetailLookup,
  type OrchestratorControl,
  type OrchestratorServices,
} from '../src/core/orchestrator.js'
import { makeRedactor } from '../src/support/redaction.js'
import { normalizePayload, type AgentDetailSnapshot } from '../src/telemetry.js'
import {
  CodeReviewFactory,
  layerAgentRunner,
  layerCodeReviewPorts,
  layerPorts,
  layerWorkflowLoader,
  layerWorkflowWatcher,
  portsConfiguration,
  TrackerFactory,
  WorkspaceManagerFactory,
  type AdapterServices,
  type AgentEventSemantics,
  type AgentLaunch,
  type AgentRunnerPort,
  type CodeReviewPort,
  type PortsConfiguration,
  type TrackerPort,
  type WorkspaceManagerPort,
  type WorkspaceSettings,
} from '../src/ports/index.js'
import { preflightWorkflow, type Workflow } from '../src/config/workflow.js'
import { runWithEnvironment, withEnvironment } from './harness/environment.js'
import type { HostToolSession } from '../src/host-tools.js'
import type { ValidatedTrackerProvider } from '../src/domain/tracker-provider.js'

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

const testEnvironment: Record<string, string> = { SYMPHONY_TEST_TOKEN: 'secret' }

const workflow: Workflow = {
  path: '/tmp/WORKFLOW.md',
  fingerprint: 'test',
  promptTemplate: 'test',
  tracker: runWithEnvironment(
    githubTrackerProvider.validate({
      owner: 'example',
      repository: 'symphony',
      token: '$SYMPHONY_TEST_TOKEN',
    }),
    testEnvironment,
  ),
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

/**
 * The adapter set one test binds. It is the harness's own shape, not an injection seam the
 * orchestrator knows about: `layerTestPorts` turns it into the layer the orchestrator resolves its
 * services from, exactly as the composition root does with the real adapters.
 */
type TestPorts = Readonly<{
  /** The configuration the composition root reads before the orchestrator loads it for itself. */
  configuration: PortsConfiguration
  loadWorkflow: (path: string) => Effect.Effect<Workflow, WorkflowError>
  makeTracker: (provider: ValidatedTrackerProvider) => TrackerPort
  /** Omit to compose no code-review services at all, which disables pull-request handoff. */
  makeCodeReview?: (provider: ValidatedTrackerProvider) => CodeReviewPort | null
  makeWorkspaces: (settings: WorkspaceSettings) => WorkspaceManagerPort
  runAgent: AgentRunnerPort['run']
  agentEventSemantics: AgentEventSemantics
  watchWorkflow: (path: string, onChange: () => void) => void
  /** The variables the run's `ConfigProvider` serves. Mutating one rotates that credential. */
  environment: Record<string, string>
  /** Observes the watcher's own teardown, which the stream's scope owns. */
  onWatchReleased?: (path: string) => void
  onTrackerReleased?: (provider: ValidatedTrackerProvider) => void
  onWorkspacesReleased?: (settings: WorkspaceSettings) => void
}>

const layerTestAdapters = (ports: TestPorts): Layer.Layer<AdapterServices> =>
  Layer.mergeAll(
    layerAgentRunner({ run: ports.runAgent, semantics: ports.agentEventSemantics }),
    // Acquired rather than returned, so a test can observe when a replaced instance is released:
    // the cell builds every instance in its own scope, and closing it is what retirement does.
    Layer.succeed(TrackerFactory, {
      make: (provider) =>
        Effect.acquireRelease(
          Effect.sync(() => ports.makeTracker(provider)),
          () => Effect.sync(() => ports.onTrackerReleased?.(provider)),
        ),
    }),
    Layer.succeed(WorkspaceManagerFactory, {
      make: (settings) =>
        Effect.acquireRelease(
          Effect.sync(() => ports.makeWorkspaces(settings)),
          () => Effect.sync(() => ports.onWorkspacesReleased?.(settings)),
        ),
    }),
    layerWorkflowLoader({
      load: ports.loadWorkflow,
      preflight: (workflow) => preflightWorkflow(workflow),
    }),
    layerWorkflowWatcher({
      // The harness pushes into the stream exactly as the chokidar adapter does, so a test drives
      // the same path the composition root binds rather than a callback seam of its own.
      changes: (path) =>
        Effect.gen(function* () {
          const changes = yield* Effect.acquireRelease(Queue.unbounded<void>(), (queue) =>
            Queue.shutdown(queue).pipe(
              Effect.zipRight(Effect.sync(() => ports.onWatchReleased?.(path))),
            ),
          )
          ports.watchWorkflow(path, () => {
            Queue.unsafeOffer(changes, undefined)
          })
          return Stream.fromQueue(changes)
        }),
    }),
  )

const layerTestPorts = (ports: TestPorts): Layer.Layer<OrchestratorServices, TrackerError> => {
  const base = layerPorts(ports.configuration, layerTestAdapters(ports))
  const makeCodeReview = ports.makeCodeReview
  if (makeCodeReview === undefined) {
    return base
  }
  return Layer.merge(
    base,
    layerCodeReviewPorts(
      ports.configuration,
      Layer.succeed(CodeReviewFactory, {
        make: (provider) => Effect.succeed(makeCodeReview(provider)),
      }),
    ),
  )
}

/**
 * Builds the test layer into the caller's scope and hands its services to the orchestrator, so the
 * ports outlive the call that started it exactly as the composition root's layer does.
 */
const startTestOrchestrator = (
  selectedWorkflowPath: string,
  ports: TestPorts,
): Effect.Effect<OrchestratorControl, WorkflowError | TrackerError, Scope.Scope> =>
  Effect.scope.pipe(
    Effect.flatMap((scope) => Layer.buildWithScope(layerTestPorts(ports), scope)),
    Effect.flatMap((services) => Effect.provide(startOrchestrator(selectedWorkflowPath), services)),
    // The environment reaches the run the way the composition root supplies it: as the provider the
    // whole program is run against, rather than as a record threaded through the ports.
    (effect) => withEnvironment(effect, ports.environment),
  )

type TestHarness = Readonly<{
  ports: TestPorts
  setWorkflow: (workflow: Workflow | WorkflowError) => void
  notifyChanged: () => void
  loads: () => number
  stateFetches: () => number
  stateFetchStates: () => readonly (readonly string[])[]
  idFetches: () => number
  idFetchTokens: () => readonly string[]
  trackerProviders: () => readonly ValidatedTrackerProvider[]
  releasedTrackers: () => readonly ValidatedTrackerProvider[]
  workspaceSettings: () => readonly WorkspaceSettings[]
  releasedWorkspaces: () => readonly WorkspaceSettings[]
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
  environment: Record<string, string> = testEnvironment,
): TestHarness => {
  let selected: Workflow | WorkflowError = initial
  let notifyChanged = (): void => undefined
  let loadCount = 0
  let stateFetchCount = 0
  const stateFetchStates: (readonly string[])[] = []
  let idFetchCount = 0
  const idFetchTokens: string[] = []
  const trackerProviders: ValidatedTrackerProvider[] = []
  const releasedTrackers: ValidatedTrackerProvider[] = []
  const workspaceSettings: WorkspaceSettings[] = []
  const releasedWorkspaces: WorkspaceSettings[] = []
  const agentRuns: Readonly<{ command: string; prompt: string; maxTurns: number }>[] = []
  let resolveAgentRun = (): void => undefined
  let onAgentEvent = (_event: AgentEvent): void => undefined
  const agentRun = new Promise<void>((resolve) => {
    resolveAgentRun = resolve
  })
  /**
   * The workflow the loader would return now. A tracker is built from a provider alone, so a fake
   * that answers from the workflow in force reads it here rather than from its own construction.
   */
  const currentWorkflow = (): Workflow => (selected instanceof WorkflowError ? initial : selected)

  const ports: TestPorts = {
    configuration: portsConfiguration(initial),
    loadWorkflow: () => {
      loadCount += 1
      return selected instanceof WorkflowError ? Effect.fail(selected) : Effect.succeed(selected)
    },
    makeTracker: (provider): TrackerPort => {
      trackerProviders.push(provider)
      return {
        fetchIssuesByStates: (states) => {
          stateFetchCount += 1
          stateFetchStates.push(states)
          const normalizedStates = new Set(states.map((state) => state.trim().toLowerCase()))
          return (
            fetchCandidates?.(currentWorkflow(), states) ??
            Effect.succeed(
              candidates(currentWorkflow()).filter((issue) =>
                normalizedStates.has(issue.state.trim().toLowerCase()),
              ),
            )
          )
        },
        fetchIssuesByIds: () =>
          Effect.sync(() => {
            idFetchCount += 1
            idFetchTokens.push(Redacted.value(githubProviderOf(provider).token))
            return candidates(currentWorkflow())
          }),
        toolSpecs: [],
        executeTool: async (name) => ({
          success: false,
          error: {
            code: 'unsupported_tool',
            message: `Unsupported host tool: ${name}`,
            retryable: false,
          },
        }),
        secretEnvironmentNames: [],
      }
    },
    makeCodeReview: (): CodeReviewPort => ({
      toolSpecs: [],
      executeTool: async (name) => ({
        success: false,
        error: {
          code: 'unsupported_tool',
          message: `Unsupported host tool: ${name}`,
          retryable: false,
        },
      }),
      handoffCompletedWork: () => Effect.succeed({ _tag: 'NoBranch', branchName: 'symphony/test' }),
      findExistingHandoff: () => Effect.succeed({ _tag: 'NoBranch', branchName: 'symphony/test' }),
      inspectPullRequest: () => Effect.die('unused'),
      mergePullRequest: () => Effect.die('unused'),
      requestPullRequestReview: () => Effect.die('unused'),
      resolveReviewThreads: () => Effect.die('unused'),
    }),
    makeWorkspaces: (settings) => {
      workspaceSettings.push(settings)
      return {
        create: () =>
          Effect.succeed({ path: '/tmp/symphony-test', key: 'test', createdNow: false }),
        exists: () => Effect.succeed(true),
        beforeRun: () => Effect.void,
        afterRun: () => Effect.void,
        remove: () => Effect.void,
      }
    },
    agentEventSemantics: codexAgentEventSemantics,
    runAgent: ({ config, prompt, maxTurns, onEvent }) =>
      Effect.sync(() => {
        agentRuns.push({ command: config.command, prompt, maxTurns })
        onAgentEvent = onEvent
        resolveAgentRun()
      }).pipe(Effect.zipRight(Effect.never)),
    environment,
    watchWorkflow: (_path, onChange) => {
      notifyChanged = onChange
    },
    onTrackerReleased: (provider) => {
      releasedTrackers.push(provider)
    },
    onWorkspacesReleased: (settings) => {
      releasedWorkspaces.push(settings)
    },
  }

  return {
    ports,
    setWorkflow: (next) => {
      selected = next
    },
    notifyChanged: () => {
      notifyChanged()
    },
    loads: () => loadCount,
    stateFetches: () => stateFetchCount,
    stateFetchStates: () => stateFetchStates,
    idFetches: () => idFetchCount,
    idFetchTokens: () => idFetchTokens,
    trackerProviders: () => trackerProviders,
    releasedTrackers: () => releasedTrackers,
    workspaceSettings: () => workspaceSettings,
    releasedWorkspaces: () => releasedWorkspaces,
    agentRuns: () => agentRuns,
    awaitAgentRun: Effect.promise(() => agentRun),
    emitAgentEvent: (event) => {
      onAgentEvent(event)
    },
  }
}

const runWithTestClock = <Value>(
  effect: Effect.Effect<Value, WorkflowError | TrackerError>,
): Promise<Value> => Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)))

const requireCodeReview = (
  ports: TestPorts,
  provider: ValidatedTrackerProvider,
): CodeReviewPort => {
  const codeReview = ports.makeCodeReview?.(provider)
  if (codeReview === undefined || codeReview === null) {
    throw new Error('test harness CodeReviewPort is unavailable')
  }
  return codeReview
}

describe('restored pull request handoffs', (): void => {
  it('rediscovers open pull requests for active issue branches when the store is missing', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-recovered-handoff-'))
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const issue = {
      ...makeIssue('example/symphony#20', 1, null, ['symphony', 'ready']),
      id: issueId('20'),
    }
    const harness = makeHarness(isolated, () => [issue])
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        findExistingHandoff: (candidate) =>
          Effect.succeed({
            _tag: 'PullRequest' as const,
            branchName: `symphony/issue-${candidate.id}`,
            pullRequestUrl: 'https://github.test/example/symphony/pull/65',
            pullRequestNumber: 65,
            created: false,
          }),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            url: 'https://github.test/example/symphony/pull/65',
            headSha: 'recovered-head',
            merged: false as const,
            state: 'open' as const,
            mergeCommitSha: null,
            mergeable: null,
            mergeState: 'unknown',
            checks: [],
            reviewDecision: null,
            reviewThreads: [],
            codexReview: { headShaPrefix: 'recovered-head', status: 'pending' as const },
          }),
      }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(snapshot.handoffs).toHaveLength(1)
    expect(snapshot.handoffs[0]).toMatchObject({
      issueId: issue.id,
      pullRequestUrl: 'https://github.test/example/symphony/pull/65',
      branchName: 'symphony/issue-20',
      headSha: 'recovered-head',
      state: 'awaiting_checks',
    })
    expect(snapshot.handoffRecovery).toMatchObject({
      status: 'completed',
      loaded: 0,
      recovered: 1,
      failed: 0,
    })
    await expect(
      Effect.runPromise(loadHandoffs(join(workspaceRoot, '.symphony', 'handoffs.json'))),
    ).resolves.toHaveLength(1)
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('skips non-dispatchable pull request records during recovery', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-nondispatchable-handoff-'))
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const pullRequestRecord = {
      ...makeIssue('example/symphony#117', 1, null, ['symphony', 'ready']),
      dispatchable: false,
    }
    const harness = makeHarness(isolated, () => [pullRequestRecord])
    let discoveries = 0
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        findExistingHandoff: () =>
          Effect.sync(() => {
            discoveries += 1
            return { _tag: 'NoBranch' as const, branchName: 'symphony/issue-117' }
          }),
      }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(discoveries).toBe(0)
    expect(harness.agentRuns()).toEqual([])
    expect(snapshot.handoffs).toEqual([])
    expect(snapshot.handoffRecovery).toMatchObject({ recovered: 0, skipped: 1 })
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('supplements a partial store without duplicating its persisted handoff', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-partial-handoff-'))
    const storePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const first = {
      ...makeIssue('example/symphony#20', 1, null, ['symphony', 'ready']),
      id: issueId('20'),
    }
    const second = {
      ...makeIssue('example/symphony#75', 1, null, ['symphony', 'ready']),
      id: issueId('75'),
    }
    await Effect.runPromise(
      saveHandoffs(storePath, [
        {
          issueId: first.id,
          identifier: first.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/65',
          branchName: 'symphony/issue-20',
          state: 'awaiting_checks',
          headSha: 'first-head',
          reason: null,
          repairAttempts: 0,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [first, second])
    let discoveries = 0
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        findExistingHandoff: (candidate) =>
          Effect.sync(() => {
            discoveries += 1
            expect(candidate.id).toBe(second.id)
            return {
              _tag: 'PullRequest' as const,
              branchName: 'symphony/issue-75',
              pullRequestUrl: 'https://github.test/example/symphony/pull/95',
              pullRequestNumber: 95,
              created: false,
            }
          }),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            url: `https://github.test/example/symphony/pull/${String(number)}`,
            headSha: number === 65 ? 'first-head' : 'second-head',
            merged: false as const,
            state: 'open' as const,
            mergeCommitSha: null,
            mergeable: null,
            mergeState: 'unknown',
            checks: [],
            reviewDecision: null,
            reviewThreads: [],
            codexReview: {
              headShaPrefix: number === 65 ? 'first-head' : 'second-head',
              status: 'pending' as const,
            },
          }),
      }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(discoveries).toBe(1)
    expect(snapshot.handoffs.map((handoff) => handoff.issueId).sort()).toEqual(['20', '75'])
    expect(snapshot.handoffRecovery).toMatchObject({ loaded: 1, recovered: 1 })
    await expect(Effect.runPromise(loadHandoffs(storePath))).resolves.toHaveLength(2)
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('reports a malformed store and does not replace it during recovery', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-malformed-handoff-'))
    const storePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    await mkdir(join(workspaceRoot, '.symphony'))
    await writeFile(storePath, '{malformed')
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const harness = makeHarness(isolated)

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(snapshot.handoffRecovery.status).toBe('degraded')
    expect(snapshot.handoffRecovery.storeError).toMatchObject({ operation: 'read' })
    expect(await readFile(storePath, 'utf8')).toBe('{malformed')
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('retains persisted entries through a transient GitHub hydration failure', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-transient-handoff-'))
    const storePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const issue = {
      ...makeIssue('example/symphony#75', 1, null, ['symphony', 'ready']),
      id: issueId('75'),
    }
    await Effect.runPromise(
      saveHandoffs(storePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/95',
          branchName: 'symphony/issue-75',
          state: 'awaiting_checks',
          headSha: 'persisted-head',
          reason: null,
          repairAttempts: 0,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    let hydrationAttempts = 0
    const ports: TestPorts = {
      ...harness.ports,
      makeTracker: (provider) => {
        const tracker = harness.ports.makeTracker(provider)
        return {
          ...tracker,
          fetchIssuesByIds: (ids, options) => {
            hydrationAttempts += 1
            return hydrationAttempts === 1
              ? Effect.fail(
                  new TrackerError({
                    category: 'tracker_request',
                    message: 'transient GitHub failure',
                    retryable: true,
                  }),
                )
              : tracker.fetchIssuesByIds(ids, options)
          },
        }
      },
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            url: 'https://github.test/example/symphony/pull/95',
            headSha: 'persisted-head',
            merged: false as const,
            state: 'open' as const,
            mergeCommitSha: null,
            mergeable: null,
            mergeState: 'unknown',
            checks: [],
            reviewDecision: null,
            reviewThreads: [],
            codexReview: { headShaPrefix: 'persisted-head', status: 'pending' as const },
          }),
      }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(hydrationAttempts).toBeGreaterThanOrEqual(2)
    expect(snapshot.handoffs).toHaveLength(1)
    expect(snapshot.handoffRecovery).toMatchObject({ loaded: 1, recovered: 0 })
    await expect(Effect.runPromise(loadHandoffs(storePath))).resolves.toHaveLength(1)
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('removes a restored handoff after its pull request is confirmed merged', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-restored-handoff-'))
    const handoffStorePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = {
      ...workflow,
      config: { ...workflow.config, workspaceRoot },
    }
    const issue = {
      ...makeIssue('example/symphony#63', 1, null, ['symphony', 'ready']),
      id: issueId('63'),
    }
    await Effect.runPromise(
      saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/44',
          branchName: 'symphony/issue-63',
          state: 'awaiting_checks',
          headSha: null,
          reason: 'GitHub pull request status is incomplete',
          repairAttempts: 0,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    let inspections = 0
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        inspectPullRequest: (pullRequestNumber) =>
          Effect.sync(() => {
            inspections += 1
            return {
              number: pullRequestNumber,
              state: 'closed' as const,
              url: null,
              headSha: null,
              merged: true as const,
              mergeCommitSha: null,
              // The merge happened long before this host came back up.
              mergedAt: '2026-08-20T09:00:00.000Z',
              mergeable: null,
              mergeState: 'unknown',
              checks: [],
              reviewDecision: null,
              reviewThreads: [],
            }
          }),
      }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(inspections).toBe(1)
    expect(snapshot.handoffs).toEqual([])
    expect(snapshot.counts.completed).toBe(1)
    // Finished work is published as described entries, not only as a count: the console scopes its
    // Finished view to a time window and needs the instant each issue landed to do that.
    expect(snapshot.completed).toHaveLength(1)
    expect(snapshot.completed[0]).toMatchObject({
      identifier: issue.identifier,
      title: issue.title,
      outcome: 'merged',
      pullRequestUrl: 'https://github.test/example/symphony/pull/44',
      // The provider's merge time, not the instant this host noticed it. Dating it now would put
      // work merged days ago back into the console's recent-activity window.
      finishedAt: '2026-08-20T09:00:00.000Z',
    })
    await expect(Effect.runPromise(loadHandoffs(handoffStorePath))).resolves.toEqual([])
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('retains a closed unmerged handoff without dispatching repair work', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-closed-handoff-'))
    const handoffStorePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = {
      ...workflow,
      config: { ...workflow.config, workspaceRoot },
    }
    const issue = {
      ...makeIssue('example/symphony#75', 1, null, ['symphony', 'ready']),
      id: issueId('75'),
    }
    await Effect.runPromise(
      saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/50',
          branchName: 'symphony/issue-75',
          state: 'awaiting_checks',
          headSha: 'closed-head',
          reason: null,
          repairAttempts: 0,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    let inspections = 0
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        inspectPullRequest: (pullRequestNumber) =>
          Effect.sync(() => {
            inspections += 1
            return {
              number: pullRequestNumber,
              state: 'closed' as const,
              url: 'https://github.test/example/symphony/pull/50',
              headSha: 'closed-head',
              merged: false as const,
              mergeCommitSha: null,
              mergeable: false,
              mergeState: 'dirty',
              checks: [],
              reviewDecision: null,
              reviewThreads: [],
            }
          }),
      }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(inspections).toBe(1)
    expect(snapshot.running).toEqual([])
    // The handoff came back from the store and nothing ran for it in this process, so its detail
    // resource would report no session. The console reads this list to decide whether to offer an
    // inspection at all, rather than rendering one that refuses.
    expect(snapshot.inspectableAgents).toEqual([])
    expect(snapshot.handoffs).toEqual([
      expect.objectContaining({
        issueId: '75',
        state: 'closed_without_merge',
        reason: 'The pull request was closed without being merged',
        repairAttempts: 0,
      }),
    ])
    await expect(Effect.runPromise(loadHandoffs(handoffStorePath))).resolves.toEqual([
      expect.objectContaining({ state: 'closed_without_merge' }),
    ])
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('awaits Codex review of the initial head before merging', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-initial-review-'))
    const handoffStorePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = {
      ...workflow,
      config: { ...workflow.config, workspaceRoot },
    }
    const issue = {
      ...makeIssue('example/symphony#20', 1, null, ['symphony', 'ready']),
      id: issueId('20'),
    }
    const initialHead = 'abcdef1234567890abcdef1234567890abcdef12'
    await Effect.runPromise(
      saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/65',
          branchName: 'symphony/issue-20',
          state: 'awaiting_checks',
          headSha: initialHead,
          reason: null,
          repairAttempts: 0,
          reviewRequestedHeadSha: null,
          reviewCompletedHeadSha: null,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    let codexReview: CodexReviewObservation = {
      headShaPrefix: initialHead.slice(0, 7),
      status: 'pending',
    }
    const requestedHeads: string[] = []
    const mergedHeads: string[] = []
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            state: 'open' as const,
            url: 'https://github.test/example/symphony/pull/65',
            headSha: initialHead,
            merged: false as const,
            mergeCommitSha: null,
            mergeable: true,
            mergeState: 'clean',
            checks: [
              {
                name: 'quality',
                status: 'completed' as const,
                conclusion: 'success',
                url: null,
              },
            ],
            reviewDecision: null,
            reviewThreads: [],
            codexReview,
          }),
        requestPullRequestReview: (_number, expectedHeadSha) =>
          Effect.sync(() => {
            requestedHeads.push(expectedHeadSha)
          }),
        mergePullRequest: (_number, expectedHeadSha) =>
          Effect.sync(() => {
            mergedHeads.push(expectedHeadSha)
            return 'merged-head'
          }),
      }),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          let snapshot = yield* control.snapshot
          expect(requestedHeads).toEqual([])
          expect(mergedHeads).toEqual([])
          expect(snapshot.handoffs[0]).toMatchObject({
            state: 'awaiting_checks',
            reviewRequestedHeadSha: initialHead,
            reviewCompletedHeadSha: null,
            reason: 'Waiting for Codex review of the current head to complete',
          })

          codexReview = { headShaPrefix: initialHead.slice(0, 7), status: 'completed' }
          yield* control.refresh
          snapshot = yield* control.snapshot
          expect(mergedHeads).toEqual([])
          expect(snapshot.handoffs[0]).toMatchObject({
            state: 'awaiting_checks',
            reviewCompletedHeadSha: initialHead,
            reason:
              'Codex review completed for the current head; waiting for review state to settle',
          })

          yield* control.refresh
          snapshot = yield* control.snapshot
          expect(mergedHeads).toEqual([initialHead])
          expect(snapshot.handoffs).toEqual([])
        }),
      ),
    )
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('requests and awaits Codex review of the repaired head before merging', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-repaired-review-'))
    const handoffStorePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = {
      ...workflow,
      config: { ...workflow.config, workspaceRoot },
    }
    const issue = {
      ...makeIssue('example/symphony#20', 1, null, ['symphony', 'ready']),
      id: issueId('20'),
    }
    const repairedHead = 'abcdef1234567890abcdef1234567890abcdef12'
    await Effect.runPromise(
      saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/65',
          branchName: 'symphony/issue-20',
          state: 'awaiting_checks',
          headSha: repairedHead,
          reason: null,
          repairAttempts: 1,
          reviewRequestedHeadSha: null,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    let codexReview: CodexReviewObservation | null = null
    const requestedHeads: string[] = []
    const mergedHeads: string[] = []
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            state: 'open' as const,
            url: 'https://github.test/example/symphony/pull/65',
            headSha: repairedHead,
            merged: false as const,
            mergeCommitSha: null,
            mergeable: true,
            mergeState: 'clean',
            checks: [
              {
                name: 'quality',
                status: 'completed' as const,
                conclusion: 'success',
                url: null,
              },
            ],
            reviewDecision: null,
            reviewThreads: [],
            codexReview,
          }),
        requestPullRequestReview: (_number, expectedHeadSha) =>
          Effect.sync(() => {
            requestedHeads.push(expectedHeadSha)
          }),
        mergePullRequest: (_number, expectedHeadSha) =>
          Effect.sync(() => {
            mergedHeads.push(expectedHeadSha)
            return 'merged-head'
          }),
      }),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          let snapshot = yield* control.snapshot
          expect(requestedHeads).toEqual([repairedHead])
          expect(mergedHeads).toEqual([])
          expect(snapshot.handoffs[0]).toMatchObject({
            state: 'awaiting_checks',
            reviewRequestedHeadSha: repairedHead,
          })

          codexReview = { headShaPrefix: repairedHead.slice(0, 7), status: 'pending' }
          yield* control.refresh
          snapshot = yield* control.snapshot
          expect(mergedHeads).toEqual([])
          expect(snapshot.handoffs[0]?.reason).toBe(
            'Waiting for Codex review of the current head to complete',
          )

          codexReview = { headShaPrefix: repairedHead.slice(0, 7), status: 'completed' }
          yield* control.refresh
          snapshot = yield* control.snapshot
          expect(mergedHeads).toEqual([])
          expect(snapshot.handoffs[0]).toMatchObject({
            state: 'awaiting_checks',
            reviewCompletedHeadSha: repairedHead,
            reason:
              'Codex review completed for the current head; waiting for review state to settle',
          })

          yield* control.refresh
          snapshot = yield* control.snapshot
          expect(mergedHeads).toEqual([repairedHead])
          expect(snapshot.handoffs).toEqual([])
        }),
      ),
    )
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('migrates contaminated legacy counts and persists the repair baseline while running', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-running-repair-'))
    const handoffStorePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = {
      ...workflow,
      config: { ...workflow.config, workspaceRoot },
    }
    const issue = {
      ...makeIssue('example/symphony#20', 1, null, ['symphony', 'ready']),
      id: issueId('20'),
    }
    const reviewedHead = 'abcdef1234567890abcdef1234567890abcdef12'
    await Effect.runPromise(
      saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/65',
          branchName: 'symphony/issue-20',
          state: 'intervention_required',
          headSha: reviewedHead,
          reason: 'Repair limit reached. Unresolved review feedback',
          repairAttempts: 3,
          reviewRequestedHeadSha: reviewedHead,
          reviewCompletedHeadSha: reviewedHead,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            state: 'open' as const,
            url: 'https://github.test/example/symphony/pull/65',
            headSha: reviewedHead,
            merged: false as const,
            mergeCommitSha: null,
            mergeable: true,
            mergeState: 'clean',
            checks: [
              {
                name: 'quality',
                status: 'completed' as const,
                conclusion: 'success',
                url: null,
              },
            ],
            reviewDecision: null,
            reviewThreads: [
              {
                id: 'thread-1',
                resolved: false,
                body: 'Fix this',
                url: null,
                commentHeadSha: reviewedHead,
              },
            ],
            codexReview: {
              headShaPrefix: reviewedHead.slice(0, 7),
              status: 'completed' as const,
            },
          }),
      }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(snapshot.running).toHaveLength(1)
    expect(snapshot.handoffs).toEqual([
      expect.objectContaining({
        issueId: '20',
        state: 'repair_needed',
        repairAttempts: 0,
        repairHeadShas: [],
        repairStartedHeadSha: reviewedHead,
        reviewRequestedHeadSha: reviewedHead,
        reviewCompletedHeadSha: reviewedHead,
      }),
    ])
    await expect(Effect.runPromise(loadHandoffs(handoffStorePath))).resolves.toEqual([
      expect.objectContaining({
        issueId: '20',
        repairAttempts: 0,
        repairHeadShas: [],
        repairStartedHeadSha: reviewedHead,
      }),
    ])
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('counts a repair only after GitHub exposes a distinct pull request head', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-repair-progress-'))
    const handoffStorePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const issue = {
      ...makeIssue('example/symphony#20', 1, null, ['symphony', 'ready']),
      id: issueId('20'),
    }
    const originalHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const repairedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    let currentHead = originalHead
    await Effect.runPromise(
      saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/65',
          branchName: 'symphony/issue-20',
          state: 'repair_needed',
          headSha: originalHead,
          reason: 'Unresolved review feedback',
          repairAttempts: 0,
          repairHeadShas: [],
          repairStartedHeadSha: null,
          reviewRequestedHeadSha: originalHead,
          reviewCompletedHeadSha: originalHead,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            state: 'open' as const,
            url: 'https://github.test/example/symphony/pull/65',
            headSha: currentHead,
            merged: false as const,
            mergeCommitSha: null,
            mergeable: true,
            mergeState: currentHead === originalHead ? 'clean' : 'unknown',
            checks: [],
            reviewDecision: null,
            reviewThreads:
              currentHead === originalHead
                ? [
                    {
                      id: 'thread-1',
                      resolved: false,
                      body: 'Fix this',
                      url: null,
                      commentHeadSha: originalHead,
                    },
                  ]
                : [],
            codexReview: {
              headShaPrefix: currentHead.slice(0, 7),
              status: 'completed' as const,
            },
          }),
        handoffCompletedWork: () =>
          Effect.succeed({
            _tag: 'PullRequest' as const,
            branchName: 'symphony/issue-20',
            pullRequestUrl: 'https://github.test/example/symphony/pull/65',
            pullRequestNumber: 65,
            created: false,
          }),
      }),
      runAgent: () =>
        Effect.sync(() => {
          currentHead = repairedHead
          return { threadId: 'thread', turnId: 'turn', turnCount: 1 }
        }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.handoffs[0]?.repairAttempts !== 1) {
            yield* Effect.yieldNow()
            yield* control.refresh
            current = yield* control.snapshot
          }
          return current
        }),
      ),
    )

    expect(snapshot.handoffs[0]).toMatchObject({
      repairAttempts: 1,
      repairHeadShas: [repairedHead],
      repairStartedHeadSha: null,
    })
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('stops a no-op repair without consuming the changed-head budget', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-repair-no-progress-'))
    const handoffStorePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const issue = {
      ...makeIssue('example/symphony#20', 1, null, ['symphony', 'ready']),
      id: issueId('20'),
    }
    const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    await Effect.runPromise(
      saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/65',
          branchName: 'symphony/issue-20',
          state: 'repair_needed',
          headSha: head,
          reason: 'The pull request conflicts with protected main',
          repairAttempts: 0,
          repairHeadShas: [],
          repairStartedHeadSha: null,
          reviewRequestedHeadSha: head,
          reviewCompletedHeadSha: head,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            state: 'open' as const,
            url: 'https://github.test/example/symphony/pull/65',
            headSha: head,
            merged: false as const,
            mergeCommitSha: null,
            mergeable: false,
            mergeState: 'dirty',
            checks: [],
            reviewDecision: null,
            reviewThreads: [],
            codexReview: { headShaPrefix: head.slice(0, 7), status: 'completed' as const },
          }),
        handoffCompletedWork: () =>
          Effect.succeed({
            _tag: 'PullRequest' as const,
            branchName: 'symphony/issue-20',
            pullRequestUrl: 'https://github.test/example/symphony/pull/65',
            pullRequestNumber: 65,
            created: false,
          }),
      }),
      runAgent: () => Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.handoffs[0]?.state !== 'intervention_required') {
            yield* Effect.yieldNow()
            yield* control.refresh
            current = yield* control.snapshot
          }
          return current
        }),
      ),
    )

    expect(snapshot.running).toEqual([])
    expect(snapshot.handoffs[0]).toMatchObject({
      state: 'intervention_required',
      repairAttempts: 0,
      repairHeadShas: [],
      repairStartedHeadSha: null,
    })
    expect(snapshot.handoffs[0]?.reason).toContain(
      'Repair agent completed without changing the pull request head',
    )
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('attributes a repair head pushed just before a restart', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-repair-restart-'))
    const handoffStorePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const issue = {
      ...makeIssue('example/symphony#20', 1, null, ['symphony', 'ready']),
      id: issueId('20'),
    }
    const originalHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const repairedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    // The repair pushed repairedHead, then the process died before reconciliation observed it.
    await Effect.runPromise(
      saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/65',
          branchName: 'symphony/issue-20',
          state: 'repair_needed',
          headSha: originalHead,
          reason: 'Repair agent running. Unresolved review feedback',
          repairAttempts: 0,
          repairHeadShas: [],
          repairStartedHeadSha: originalHead,
          reviewRequestedHeadSha: originalHead,
          reviewCompletedHeadSha: originalHead,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            state: 'open' as const,
            url: 'https://github.test/example/symphony/pull/65',
            headSha: repairedHead,
            merged: false as const,
            mergeCommitSha: null,
            mergeable: true,
            mergeState: 'clean',
            checks: [],
            reviewDecision: null,
            reviewThreads: [],
            codexReview: {
              headShaPrefix: repairedHead.slice(0, 7),
              status: 'completed' as const,
            },
          }),
        handoffCompletedWork: () =>
          Effect.succeed({
            _tag: 'PullRequest' as const,
            branchName: 'symphony/issue-20',
            pullRequestUrl: 'https://github.test/example/symphony/pull/65',
            pullRequestNumber: 65,
            created: false,
          }),
      }),
      runAgent: () => Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(snapshot.handoffs[0]).toMatchObject({
      repairAttempts: 1,
      repairHeadShas: [repairedHead],
      repairStartedHeadSha: null,
    })
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('detects a repair cycle back to the pre-repair head', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-repair-cycle-'))
    const handoffStorePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const issue = {
      ...makeIssue('example/symphony#20', 1, null, ['symphony', 'ready']),
      id: issueId('20'),
    }
    const initialHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const repairedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    // The first repair moved the branch off initialHead; the second put it back. initialHead was
    // only ever a baseline, so it is the head the budget counter alone cannot remember.
    await Effect.runPromise(
      saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/65',
          branchName: 'symphony/issue-20',
          state: 'repair_needed',
          headSha: repairedHead,
          reason: 'Repair agent running. Unresolved review feedback',
          repairAttempts: 1,
          repairHeadShas: [repairedHead],
          repairObservedHeadShas: [initialHead, repairedHead],
          repairStartedHeadSha: repairedHead,
          reviewRequestedHeadSha: repairedHead,
          reviewCompletedHeadSha: repairedHead,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            state: 'open' as const,
            url: 'https://github.test/example/symphony/pull/65',
            headSha: initialHead,
            merged: false as const,
            mergeCommitSha: null,
            mergeable: true,
            mergeState: 'clean',
            checks: [],
            reviewDecision: null,
            reviewThreads: [],
            codexReview: { headShaPrefix: initialHead.slice(0, 7), status: 'completed' as const },
          }),
        handoffCompletedWork: () =>
          Effect.succeed({
            _tag: 'PullRequest' as const,
            branchName: 'symphony/issue-20',
            pullRequestUrl: 'https://github.test/example/symphony/pull/65',
            pullRequestNumber: 65,
            created: false,
          }),
      }),
      runAgent: () => Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    // Returning to an already observed head is a cycle, not progress: it must not buy another
    // repair or another slot in the budget.
    expect(snapshot.handoffs[0]).toMatchObject({
      state: 'intervention_required',
      repairAttempts: 1,
    })
    expect(snapshot.handoffs[0]?.reason).toContain('already observed repair head')
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('treats a repair interrupted by a restart as retryable, not a no-op', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-repair-interrupted-'))
    const handoffStorePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const issue = {
      ...makeIssue('example/symphony#20', 1, null, ['symphony', 'ready']),
      id: issueId('20'),
    }
    const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    // The repair was dispatched and its baseline persisted, then the process died before the
    // agent pushed anything. The head is therefore unchanged, but nothing was a no-op.
    await Effect.runPromise(
      saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/65',
          branchName: 'symphony/issue-20',
          state: 'repair_needed',
          headSha: head,
          reason: 'Repair agent running. Unresolved review feedback',
          repairAttempts: 0,
          repairHeadShas: [],
          repairStartedHeadSha: head,
          reviewRequestedHeadSha: head,
          reviewCompletedHeadSha: head,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            state: 'open' as const,
            url: 'https://github.test/example/symphony/pull/65',
            headSha: head,
            merged: false as const,
            mergeCommitSha: null,
            mergeable: true,
            mergeState: 'clean',
            checks: [],
            reviewDecision: null,
            reviewThreads: [
              {
                id: 'thread-1',
                resolved: false,
                body: 'Fix this',
                url: null,
                commentHeadSha: head,
              },
            ],
            codexReview: { headShaPrefix: head.slice(0, 7), status: 'completed' as const },
          }),
        handoffCompletedWork: () =>
          Effect.succeed({
            _tag: 'PullRequest' as const,
            branchName: 'symphony/issue-20',
            pullRequestUrl: 'https://github.test/example/symphony/pull/65',
            pullRequestNumber: 65,
            created: false,
          }),
      }),
      runAgent: () => Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    // The interrupted repair neither consumed the changed-head budget nor locked the handoff out
    // of further automatic repairs.
    expect(snapshot.handoffs[0]).toMatchObject({
      repairAttempts: 0,
      repairHeadShas: [],
    })
    expect(snapshot.handoffs[0]?.state).not.toBe('intervention_required')
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('keeps observing a handoff that needs intervention', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-intervention-observed-'))
    const handoffStorePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const issue = {
      ...makeIssue('example/symphony#20', 1, null, ['symphony', 'ready']),
      id: issueId('20'),
    }
    const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    await Effect.runPromise(
      saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/symphony/pull/65',
          branchName: 'symphony/issue-20',
          state: 'intervention_required',
          headSha: head,
          reason: 'Repair agent completed without changing the pull request head.',
          repairAttempts: 1,
          repairHeadShas: [head],
          repairStartedHeadSha: null,
          reviewRequestedHeadSha: head,
          reviewCompletedHeadSha: head,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    let inspections = 0
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        inspectPullRequest: (number) =>
          Effect.sync(() => {
            inspections += 1
            // The operator merges the pull request by hand after the second observation.
            return inspections < 2
              ? ({
                  number,
                  state: 'open' as const,
                  url: 'https://github.test/example/symphony/pull/65',
                  headSha: head,
                  merged: false as const,
                  mergeCommitSha: null,
                  mergeable: false,
                  mergeState: 'dirty',
                  checks: [],
                  reviewDecision: null,
                  reviewThreads: [],
                  codexReview: { headShaPrefix: head.slice(0, 7), status: 'completed' as const },
                } as const)
              : ({
                  number,
                  state: 'closed' as const,
                  url: 'https://github.test/example/symphony/pull/65',
                  headSha: head,
                  merged: true as const,
                  mergeCommitSha: 'cccccccccccccccccccccccccccccccccccccccc',
                  mergeable: null,
                  mergeState: null,
                  checks: [],
                  reviewDecision: null,
                  reviewThreads: [],
                  codexReview: null,
                } as const)
          }),
      }),
    }

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          // Two observations: the first finds it still open and unrepaired, the second finds the
          // operator's manual merge.
          yield* control.refresh
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    // The intervention state suppressed further repairs but never stopped observation, so the
    // manual merge was seen and the handoff no longer holds the issue.
    expect(inspections).toBeGreaterThan(1)
    expect(snapshot.handoffs).toEqual([])
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('does not turn a continuation retry into a pull request repair', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-retry-isolation-'))
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const issue = {
      ...makeIssue('example/symphony#20', 1, null, ['symphony', 'ready']),
      id: issueId('20'),
    }
    const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const harness = makeHarness(isolated, () => [issue])
    let handoffCalls = 0
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        handoffCompletedWork: () =>
          Effect.sync(() => {
            handoffCalls += 1
            return handoffCalls === 1
              ? ({ _tag: 'NoBranch', branchName: 'symphony/issue-20' } as const)
              : ({
                  _tag: 'PullRequest',
                  branchName: 'symphony/issue-20',
                  pullRequestUrl: 'https://github.test/example/symphony/pull/65',
                  pullRequestNumber: 65,
                  created: true,
                } as const)
          }),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            state: 'open' as const,
            url: 'https://github.test/example/symphony/pull/65',
            headSha: head,
            merged: false as const,
            mergeCommitSha: null,
            mergeable: null,
            mergeState: 'unknown',
            checks: [],
            reviewDecision: null,
            reviewThreads: [],
            codexReview: { headShaPrefix: head.slice(0, 7), status: 'pending' as const },
          }),
      }),
      runAgent: () => Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
    }

    const snapshot = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          yield* TestClock.adjust('1 second')
          while (current.handoffs.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          return current
        }),
      ),
    )

    expect(handoffCalls).toBe(2)
    expect(snapshot.handoffs[0]).toMatchObject({
      repairAttempts: 0,
      repairHeadShas: [],
      repairStartedHeadSha: null,
    })
    await rm(workspaceRoot, { force: true, recursive: true })
  })
})

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
    const ports: TestPorts = {
      ...harness.ports,
      makeTracker: (provider) => {
        const tracker = harness.ports.makeTracker(provider)
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
      makeWorkspaces: (settings) => {
        const workspaces = harness.ports.makeWorkspaces(settings)
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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
    const ports: TestPorts = {
      ...harness.ports,
      makeTracker: (provider) => {
        const tracker = harness.ports.makeTracker(provider)
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
          yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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
    const ports: TestPorts = {
      ...harness.ports,
      makeTracker: (provider) => ({
        ...harness.ports.makeTracker(provider),
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
      makeWorkspaces: (settings) => ({
        ...harness.ports.makeWorkspaces(settings),
        remove: (identifier) => Effect.sync(() => removed.push(identifier)).pipe(Effect.asVoid),
      }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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
    const ports: TestPorts = {
      ...harness.ports,
      makeTracker: (provider) => {
        const tracker = harness.ports.makeTracker(provider)
        return {
          ...tracker,
          fetchIssuesByStates: (states, labels) =>
            states.includes('closed')
              ? Effect.succeed([terminalIssue])
              : tracker.fetchIssuesByStates(states, labels),
          fetchIssuesByIds: () => Effect.succeed([terminalIssue]),
        }
      },
      makeWorkspaces: (settings) => {
        const workspaces = harness.ports.makeWorkspaces(settings)
        return { ...workspaces, remove: () => Effect.promise(() => cleanup) }
      },
    }

    const running = runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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
    const ports: TestPorts = {
      ...harness.ports,
      makeTracker: (provider) => ({
        ...harness.ports.makeTracker(provider),
        fetchIssuesByStates: () => Effect.succeed([terminalIssue]),
        fetchIssuesByIds: (_ids, options) => {
          expect(options?.hydrateDependencies).toBe(false)
          return Effect.succeed([reopenedIssue])
        },
      }),
      makeWorkspaces: (settings) => ({
        ...harness.ports.makeWorkspaces(settings),
        remove: (identifier) => Effect.sync(() => removed.push(identifier)).pipe(Effect.asVoid),
      }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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
    const ports: TestPorts = {
      ...harness.ports,
      makeTracker: (provider) => ({
        ...harness.ports.makeTracker(provider),
        fetchIssuesByStates: () => Effect.succeed([terminalIssue]),
        fetchIssuesByIds: () => {
          idFetches += 1
          return Effect.succeed([terminalIssue])
        },
      }),
      makeWorkspaces: (settings) => ({
        ...harness.ports.makeWorkspaces(settings),
        exists: () => Effect.succeed(false),
      }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
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

    const snapshot = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* control.refresh
          harness.setWorkflow(reloaded)
          yield* control.refresh
          const snapshot = yield* control.snapshot
          yield* harness.awaitAgentRun
          return snapshot
        }),
      ),
    )

    expect(harness.trackerProviders().map(githubProviderOf).at(-1)?.repository).toBe(
      'reloaded-repository',
    )
    expect(harness.stateFetchStates().at(-1)).toEqual(['open', 'queued'])
    expect(snapshot.pollingIntervalMs).toBe(7_000)
    expect(snapshot.maxConcurrentAgents).toBe(3)
    expect(harness.workspaceSettings().at(-1)?.root).toBe('/tmp/reloaded-workspaces')
    expect(harness.workspaceSettings().at(-1)?.hooks.beforeRun).toBe('echo reloaded')
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
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

  it('reloads the workflow when the watcher reports a change', async (): Promise<void> => {
    const harness = makeHarness(changedWorkflow({ fingerprint: 'initial' }))

    const fingerprint = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* control.refresh
          harness.setWorkflow(changedWorkflow({ fingerprint: 'watched' }))
          // A change that arrives while a tick is already queued is coalesced into it by design,
          // so the edit is signalled until the reload it asks for has actually been observed.
          let snapshot = yield* control.snapshot
          while (snapshot.effectiveWorkflow.fingerprint !== 'watched') {
            harness.notifyChanged()
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }
          return snapshot.effectiveWorkflow.fingerprint
        }),
      ),
    )

    expect(fingerprint).toBe('watched')
  })

  it('installs the workflow watcher before startup returns', async (): Promise<void> => {
    const harness = makeHarness(changedWorkflow({ fingerprint: 'initial' }))
    let watchedPath: string | null = null
    const ports: TestPorts = {
      ...harness.ports,
      watchWorkflow: (path, onChange) => {
        watchedPath = path
        harness.ports.watchWorkflow(path, onChange)
      },
    }

    const observed = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          // Read before yielding: an edit made the instant startup returns has to find the watcher
          // already in place, not a subscription still waiting on a fiber to be scheduled.
          return watchedPath
        }),
      ),
    )

    expect(observed).toBe('/tmp/WORKFLOW.md')
  })

  it('interrupts a watcher-triggered tick when the orchestrator shuts down', async (): Promise<void> => {
    let pollShouldBlock = false
    let pollBlocked = false
    let pollInterrupted = false
    let watchReleased = false
    const harness = makeHarness(
      changedWorkflow({ fingerprint: 'initial' }),
      () => [],
      (_effectiveWorkflow, states) => {
        if (!states.includes('open') || !pollShouldBlock) {
          return Effect.succeed([])
        }
        return Effect.sync(() => {
          pollBlocked = true
        }).pipe(
          Effect.zipRight(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              pollInterrupted = true
            }),
          ),
        )
      },
    )
    const ports: TestPorts = {
      ...harness.ports,
      onWatchReleased: () => {
        watchReleased = true
      },
    }

    const loads = await runWithTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const control = yield* Scope.extend(startTestOrchestrator('/tmp/WORKFLOW.md', ports), scope)
        yield* control.refresh
        pollShouldBlock = true
        // A change that arrives while a tick is already queued is coalesced into it by design, so
        // the edit is signalled until the poll it asks for is genuinely in flight.
        while (!pollBlocked) {
          harness.notifyChanged()
          yield* Effect.yieldNow()
        }
        expect(pollInterrupted).toBe(false)
        // Closing the scope is what shutdown does. It returns only once every fiber the scope owns
        // has finished being interrupted, so the poll cannot still be running afterwards.
        yield* Scope.close(scope, Exit.void)
        const atShutdown = harness.loads()
        harness.notifyChanged()
        yield* Effect.yieldNow()
        return { atShutdown, afterShutdown: harness.loads() }
      }),
    )

    expect(pollInterrupted).toBe(true)
    expect(watchReleased).toBe(true)
    expect(loads.afterShutdown).toBe(loads.atShutdown)
  })

  it('uses the provider returned by dispatch preflight', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#1', 1, null, ['symphony', 'ready'])
    const environment: Record<string, string> = { SYMPHONY_TEST_TOKEN: 'secret' }
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
          yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* harness.awaitAgentRun
        }),
      ),
    )

    const latest = harness.trackerProviders().map(githubProviderOf).at(-1)
    expect(latest === undefined ? null : Redacted.value(latest.token)).toBe('rotated')
  })

  it('cancels a running worker when the operator explicitly pauses its issue', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#1', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(changedWorkflow({ fingerprint: 'initial' }), () => [issue])

    const snapshot = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
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
    const environment: Record<string, string> = { SYMPHONY_TEST_TOKEN: 'secret' }
    const harness = makeHarness(workflow, () => [issue])
    let refreshIssue: AgentLaunch['refreshIssue'] | null = null
    const ports: TestPorts = {
      ...harness.ports,
      environment,
      runAgent: (launch) => {
        refreshIssue = launch.refreshIssue
        return harness.ports.runAgent(launch)
      },
    }
    const refreshActiveIssue = (): Effect.Effect<void> =>
      refreshIssue === null
        ? Effect.die('worker did not provide an issue refresh callback')
        : refreshIssue().pipe(Effect.asVoid, Effect.orDie)

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* harness.awaitAgentRun
          environment['SYMPHONY_TEST_TOKEN'] = 'rotated'
          yield* control.refresh
          yield* refreshActiveIssue()
        }),
      ),
    )

    expect(harness.idFetchTokens().at(-1)).toBe('rotated')
  })

  it("routes a live session's host tool calls to the tracker a rotation installed", async (): Promise<void> => {
    const issue = makeIssue('example/symphony#1', 1, null, ['symphony', 'ready'])
    const environment: Record<string, string> = { SYMPHONY_TEST_TOKEN: 'secret' }
    const harness = makeHarness(workflow, () => [issue])
    const executedTokens: string[] = []
    let session: HostToolSession | null = null
    const ports: TestPorts = {
      ...harness.ports,
      environment,
      makeTracker: (provider) => ({
        ...harness.ports.makeTracker(provider),
        toolSpecs: [{ name: 'symphony_issue_state', description: 'set state', inputSchema: {} }],
        executeTool: () => {
          executedTokens.push(Redacted.value(githubProviderOf(provider).token))
          return Promise.resolve({ success: true, data: null })
        },
      }),
      runAgent: (launch) => {
        session = launch.hostTools ?? null
        return harness.ports.runAgent(launch)
      },
    }
    const callHostTool = (): Effect.Effect<void> => {
      const current = session
      if (current === null) {
        return Effect.die('worker was launched without a host tool session')
      }
      return Effect.promise(async () => {
        await current.execute('symphony_issue_state', null, current.context)
      })
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* harness.awaitAgentRun
          environment['SYMPHONY_TEST_TOKEN'] = 'rotated'
          yield* control.refresh
          yield* callHostTool()
        }),
      ),
    )

    expect(executedTokens).toEqual(['rotated'])
  })

  it('rebuilds the tracker when the referenced secret is rotated in the environment', async (): Promise<void> => {
    const environment: Record<string, string> = { SYMPHONY_TEST_TOKEN: 'first' }
    const harness = makeHarness(workflow)

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            environment,
          })
          yield* control.refresh
          environment['SYMPHONY_TEST_TOKEN'] = 'rotated'
          yield* control.refresh
        }),
      ),
    )

    // Twice at startup: the layer builds the first instance from the workflow the composition root
    // read, and the orchestrator replaces it with one built from the workflow it loaded itself.
    expect(
      harness.trackerProviders().map((each) => Redacted.value(githubProviderOf(each).token)),
    ).toEqual(['secret', 'secret', 'first', 'rotated'])
  })

  it('retains the last known good tracker when the secret disappears', async (): Promise<void> => {
    const environment: Record<string, string> = { SYMPHONY_TEST_TOKEN: 'first' }
    const harness = makeHarness(workflow)

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            environment,
          })
          yield* control.refresh
          delete environment['SYMPHONY_TEST_TOKEN']
          yield* control.refresh
        }),
      ),
    )

    expect(
      harness.trackerProviders().map((each) => Redacted.value(githubProviderOf(each).token)),
    ).toEqual(['secret', 'secret', 'first'])
  })
})

describe('rebuilt port lifecycle', (): void => {
  it('keeps the tracker a rotation replaced until the run that used it ends', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#1', 1, null, ['symphony', 'ready'])
    const environment: Record<string, string> = { SYMPHONY_TEST_TOKEN: 'secret' }
    let markStarted = (): void => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let finishWorker = (): void => undefined
    const finished = new Promise<void>((resolve) => {
      finishWorker = resolve
    })
    const harness = makeHarness(workflow, () => [issue], undefined, environment)
    const ports: TestPorts = {
      ...harness.ports,
      runAgent: () =>
        Effect.sync(markStarted).pipe(
          Effect.zipRight(Effect.promise(() => finished)),
          Effect.as({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
        ),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* Effect.promise(() => started)
          environment['SYMPHONY_TEST_TOKEN'] = 'rotated'
          yield* control.refresh

          expect(
            harness.trackerProviders().map((each) => Redacted.value(githubProviderOf(each).token)),
          ).toEqual(['secret', 'secret', 'rotated'])
          // Only the layer's instance, replaced at startup before any run could reach it. The
          // running worker adopted the rotated tracker, but a call it made a moment earlier may
          // still be awaiting the one it replaced.
          expect(harness.releasedTrackers()).toHaveLength(1)

          finishWorker()
          yield* control.refresh
          yield* control.refresh

          expect(
            harness.releasedTrackers().map((each) => Redacted.value(githubProviderOf(each).token)),
          ).toEqual(['secret', 'secret'])
        }),
      ),
    )
  })

  it('retires what a refused reload replaced before it refused', async (): Promise<void> => {
    // The tracker cell installs a replacement, and only then does the code-review rebuild refuse.
    // Every retry of the same invalid workflow displaces another instance, so the predecessors have
    // to reach the drain even though the reload as a whole produced nothing.
    let handoffAvailable = true
    const harness = makeHarness(changedWorkflow({ fingerprint: 'initial' }))
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) =>
        handoffAvailable ? requireCodeReview(harness.ports, provider) : null,
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          const beforeReload = harness.releasedTrackers().length

          handoffAvailable = false
          harness.setWorkflow(changedWorkflow({ fingerprint: 'no-code-review' }))
          // Two refused reloads and a further pass to drain: the first displaces the instance the
          // orchestrator is still using, and the second displaces the first's orphan.
          yield* control.refresh
          yield* control.refresh
          yield* control.refresh

          const snapshot = yield* control.snapshot
          expect(snapshot.workflowReloadError?.message).toContain('does not supply CodeReviewPort')
          expect(snapshot.effectiveWorkflow.fingerprint).toBe('initial')
          expect(harness.releasedTrackers().length).toBeGreaterThan(beforeReload)
        }),
      ),
    )
  })

  it("releases a run's superseded ports when it ends, even as its handoff lives on", async (): Promise<void> => {
    const issue = makeIssue('example/symphony#1', 1, null, ['symphony', 'ready'])
    const environment: Record<string, string> = { SYMPHONY_TEST_TOKEN: 'secret' }
    let markStarted = (): void => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let finishWorker = (): void => undefined
    const finished = new Promise<void>((resolve) => {
      finishWorker = resolve
    })
    // An isolated root: this run really does hand off, so it reads and writes a handoff store.
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-superseded-handoff-'))
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const harness = makeHarness(isolated, () => [issue], undefined, environment)
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        handoffCompletedWork: () =>
          Effect.succeed({
            _tag: 'PullRequest' as const,
            branchName: 'symphony/issue-1',
            pullRequestUrl: 'https://github.test/example/symphony/pull/65',
            pullRequestNumber: 65,
            created: true,
          }),
        inspectPullRequest: (number) =>
          Effect.succeed({
            number,
            state: 'open' as const,
            url: 'https://github.test/example/symphony/pull/65',
            headSha: 'handoff-head',
            merged: false as const,
            mergeCommitSha: null,
            mergeable: null,
            mergeState: 'unknown',
            checks: [],
            reviewDecision: null,
            reviewThreads: [],
          }),
        requestPullRequestReview: () => Effect.void,
      }),
      runAgent: () =>
        Effect.sync(markStarted).pipe(
          Effect.zipRight(Effect.promise(() => finished)),
          Effect.as({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
        ),
    }

    const snapshot = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* Effect.promise(() => started)
          environment['SYMPHONY_TEST_TOKEN'] = 'rotated'
          yield* control.refresh
          expect(harness.releasedTrackers()).toHaveLength(1)

          finishWorker()
          yield* control.refresh
          yield* control.refresh
          const snapshot = yield* control.snapshot

          // The run has ended into a handoff under the same issue, and that handoff holds the
          // adopted tracker — so what the run superseded is free while the pull request stays open.
          expect(snapshot.handoffs).toHaveLength(1)
          expect(
            harness.releasedTrackers().map((each) => Redacted.value(githubProviderOf(each).token)),
          ).toEqual(['secret', 'secret'])
          return snapshot
        }),
      ),
    )

    expect(snapshot.handoffs[0]).toMatchObject({ state: 'awaiting_checks' })
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('keeps the workspace manager a reload replaced until the worker holding it ends', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#1', 1, null, ['symphony', 'ready'])
    const initial = changedWorkflow({ fingerprint: 'initial' })
    const reloaded: Workflow = {
      ...changedWorkflow({ fingerprint: 'reloaded' }),
      config: { ...initial.config, workspaceRoot: '/tmp/symphony-reloaded' },
    }
    let markStarted = (): void => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let finishWorker = (): void => undefined
    const finished = new Promise<void>((resolve) => {
      finishWorker = resolve
    })
    const harness = makeHarness(initial, () => [issue])
    // Handoff disabled: the finished worker schedules a continuation retry, which holds no
    // execution snapshot, so the only remaining holder is the run that has just ended.
    const { makeCodeReview: omittedCodeReview, ...trackerOnlyPorts } = harness.ports
    void omittedCodeReview
    const ports: TestPorts = {
      ...trackerOnlyPorts,
      runAgent: () =>
        Effect.sync(markStarted).pipe(
          Effect.zipRight(Effect.promise(() => finished)),
          Effect.as({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
        ),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* Effect.promise(() => started)
          harness.setWorkflow(reloaded)
          yield* control.refresh

          expect(harness.workspaceSettings().map((each) => each.root)).toEqual([
            '/tmp/symphony',
            '/tmp/symphony',
            '/tmp/symphony-reloaded',
          ])
          // One release, not two: the instance the layer built was replaced at startup and freed on
          // the first poll, while the one the running worker holds outlives the reload.
          expect(harness.releasedWorkspaces()).toHaveLength(1)

          finishWorker()
          yield* control.refresh
          yield* control.refresh

          expect(harness.releasedWorkspaces()).toHaveLength(2)
        }),
      ),
    )
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
    const ports: TestPorts = {
      ...harness.ports,
      makeTracker: (provider) => ({
        ...harness.ports.makeTracker(provider),
        fetchIssuesByStates: (_states, dependencyLabels) => {
          requested.push(dependencyLabels)
          return Effect.succeed([])
        },
      }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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
    const ports: TestPorts = {
      ...harness.ports,
      makeTracker: (provider) => ({
        ...harness.ports.makeTracker(provider),
        fetchIssuesByStates: (_states, dependencyLabels) => {
          requested.push(dependencyLabels)
          return Effect.succeed([])
        },
      }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
        }),
      ),
    )

    expect(requested).toContainEqual(['symphony', 'ready'])
  })
})

type FakeAgent = Readonly<{
  notify: (method: string, params: Record<string, unknown>) => void
  settle: (outcome: 'completed' | 'failed') => void
}>

const secretRedactor = makeRedactor(['s3cret-token-value'])

/**
 * A stand-in worker that exposes the same `onEvent` contract the Codex client uses, with payloads
 * built by the same normalizer, so what the orchestrator retains is what a real session would
 * produce.
 */
const makeAgentFactory = (): Readonly<{
  agents: Map<string, FakeAgent>
  runAgent: AgentRunnerPort['run']
}> => {
  const agents = new Map<string, FakeAgent>()
  return {
    agents,
    runAgent: (launch) =>
      Effect.async<AgentResult, AgentError>((resume) => {
        agents.set(launch.issue.identifier, {
          notify: (method, params) => {
            const telemetry = telemetryFrom(method, { params: params as JsonObject })
            launch.onEvent({
              event: method,
              timestamp: new Date(),
              processId: 4242,
              message: null,
              usage: telemetry.usage,
              rateLimits: telemetry.rateLimits,
              threadId: 'thread-1',
              turnId: 'turn-1',
              sessionId: 'thread-1',
              turnCount: 1,
              turnStatus: null,
              payload: normalizePayload(
                method,
                params as Parameters<typeof normalizePayload>[1],
                secretRedactor,
              ),
            })
          },
          settle: (outcome) => {
            resume(
              outcome === 'completed'
                ? Effect.succeed({ threadId: 'thread-1', turnId: 'turn-1', turnCount: 1 })
                : Effect.fail(new AgentError({ category: 'turn_failed', message: 'turn failed' })),
            )
          },
        })
      }),
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

const waitUntil = async <Value>(produce: () => Value | null, what: string): Promise<Value> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = produce()
    if (value !== null) {
      return value
    }
    await settle()
  }
  throw new Error(`timed out waiting for ${what}`)
}

const awaitAgent = (agents: Map<string, FakeAgent>, identifier: string): Promise<FakeAgent> =>
  waitUntil(() => agents.get(identifier) ?? null, `agent ${identifier}`)

const readDetail = (control: OrchestratorControl, identifier: string): AgentDetailLookup =>
  Effect.runSync(control.agentDetail(identifier))

const awaitDetail = (
  control: OrchestratorControl,
  identifier: string,
  predicate: (detail: AgentDetailSnapshot) => boolean,
  what: string,
): Promise<AgentDetailSnapshot> =>
  waitUntil(() => {
    const lookup = readDetail(control, identifier)
    return lookup._tag === 'Found' && predicate(lookup.detail) ? lookup.detail : null
  }, what)

describe('live agent detail', (): void => {
  it('publishes an ordered, redacted, bounded timeline for a running agent', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#7', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    const factory = makeAgentFactory()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          const agent = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/symphony#7'),
          )
          agent.notify('item/completed', {
            item: { type: 'agentMessage', text: 'pushed with s3cret-token-value' },
          })
          agent.notify('item/started', {
            item: { type: 'commandExecution', command: 'pnpm check', status: 'in_progress' },
          })
          agent.notify('item/completed', {
            item: {
              type: 'fileChange',
              path: 'src/telemetry.ts',
              kind: 'updated',
              addedLines: 9,
              deletedLines: 1,
            },
          })
          agent.notify('turn/usage', {
            usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
          })
          agent.notify('account/rateLimits/updated', {
            rateLimits: { primary: { usedPercent: 40, windowMinutes: 300, resetsInSeconds: 60 } },
          })
          const detail = yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/symphony#7',
              (candidate) => candidate.timeline.events.length >= 5,
              'five retained events',
            ),
          )
          const snapshot = yield* control.snapshot
          return { detail, snapshot }
        }),
      ),
    )

    const detail = observed.detail
    expect(detail.status).toBe('running')
    expect(detail.self).toBe('/api/v1/agents/example%2Fsymphony%237')
    expect(observed.snapshot.running[0]?.detailUrl).toBe(detail.self)
    expect(detail.timeline.events.map((event) => event.category)).toEqual([
      'message',
      'command',
      'file',
      'usage',
      'usage',
    ])
    expect(detail.timeline.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(JSON.stringify(detail)).toContain('[REDACTED]')
    expect(JSON.stringify(detail)).not.toContain('s3cret-token-value')
    expect(detail.identity).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      // Session identity is the thread, stable for the session's whole lifetime.
      sessionId: 'thread-1',
      processId: 4242,
      turnNumber: 1,
      workerHost: 'local',
    })
    expect(detail.usage.totalTokens).toBe(18)
    expect(detail.rateLimits).toEqual([
      { name: 'primary', usedPercent: 40, windowMinutes: 300, resetsInSeconds: 60 },
    ])
    expect(detail.workspace).toMatchObject({ dirtyFileCount: 1, addedLines: 9, deletedLines: 1 })
    expect(detail.activity.stallTimeoutMs).toBe(30_000)
    // The runtime snapshot keeps the client's own merged rate-limit object; the per-agent detail
    // is the typed view of the same reading.
    expect(observed.snapshot.rateLimits).toMatchObject({ primary: { usedPercent: 40 } })
  })

  it('separates attempts across a retry while keeping one rising sequence', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#8', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    const factory = makeAgentFactory()

    const detail = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          const first = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/symphony#8'),
          )
          first.notify('item/completed', { item: { type: 'reasoning' } })
          yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/symphony#8',
              (candidate) => candidate.timeline.events.length === 1,
              'the first attempt event',
            ),
          )
          factory.agents.delete('example/symphony#8')
          first.settle('failed')
          const retrying = yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/symphony#8',
              (candidate) => candidate.status === 'retrying',
              'the scheduled retry',
            ),
          )
          expect(retrying.retry?.attempt).toBe(1)
          expect(retrying.phase.phase).toBe('retrying')
          yield* TestClock.adjust('20 seconds')
          const second = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/symphony#8'),
          )
          second.notify('item/completed', {
            item: { type: 'commandExecution', command: 'pnpm test', status: 'completed' },
          })
          return yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/symphony#8',
              (candidate) =>
                candidate.attempt.current === 1 &&
                candidate.status === 'running' &&
                candidate.timeline.events.length === 4,
              'the second attempt',
            ),
          )
        }),
      ).pipe(Effect.provide(TestContext.TestContext)),
    )

    expect(detail.timeline.events.map((event) => [event.attempt, event.category])).toEqual([
      [0, 'reasoning'],
      [0, 'retry'],
      [1, 'session'],
      [1, 'command'],
    ])
    expect(detail.timeline.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4])
    expect(detail.attempt.attempts.map((attempt) => attempt.outcome)).toEqual([
      'retrying',
      'running',
    ])
    expect(detail.attempt.retries).toBe(1)
  })

  it('keeps concurrent agents in separate records', async (): Promise<void> => {
    const issues = [
      makeIssue('example/symphony#11', 1, null, ['symphony', 'ready']),
      makeIssue('example/symphony#12', 1, null, ['symphony', 'ready']),
    ]
    const harness = makeHarness(
      changedWorkflow({ fingerprint: 'test', maxConcurrentAgents: 2 }),
      () => issues,
    )
    const factory = makeAgentFactory()

    const details = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          const first = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/symphony#11'),
          )
          const second = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/symphony#12'),
          )
          first.notify('item/completed', { item: { type: 'reasoning' } })
          second.notify('item/completed', {
            item: { type: 'commandExecution', command: 'pnpm lint', status: 'completed' },
          })
          second.notify('item/completed', {
            item: { type: 'fileChange', path: 'src/server.ts', kind: 'add', addedLines: 4 },
          })
          const left = yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/symphony#11',
              (candidate) => candidate.timeline.events.length === 1,
              'the first record',
            ),
          )
          const right = yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/symphony#12',
              (candidate) => candidate.timeline.events.length === 2,
              'the second record',
            ),
          )
          return { left, right }
        }),
      ),
    )

    expect(details.left.timeline.events.map((event) => event.category)).toEqual(['reasoning'])
    expect(details.right.timeline.events.map((event) => event.category)).toEqual([
      'command',
      'file',
    ])
    expect(details.left.workspace.dirtyFileCount).toBe(0)
    expect(details.right.workspace.dirtyFileCount).toBe(1)
  })

  it('records handoff progress and keeps the completed record readable', async (): Promise<void> => {
    // A handoff is persisted, so this run gets a workspace root of its own.
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-handoff-detail-'))
    const isolated: Workflow = {
      ...workflow,
      config: { ...workflow.config, workspaceRoot },
    }
    const issue = {
      ...makeIssue('example/symphony#13', 1, null, ['symphony', 'ready']),
      id: issueId('13'),
    }
    const harness = makeHarness(isolated, () => [issue])
    const factory = makeAgentFactory()
    const ports: TestPorts = {
      ...harness.ports,
      runAgent: factory.runAgent,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        handoffCompletedWork: () =>
          Effect.succeed({
            _tag: 'PullRequest',
            branchName: 'symphony/issue-13',
            pullRequestUrl: 'https://example.test/pull/61',
            pullRequestNumber: 61,
            created: true,
          }),
      }),
    }

    const detail = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          const agent = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/symphony#13'),
          )
          agent.settle('completed')
          return yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/symphony#13',
              // The worker leaves `running` before the tracker is asked, so the handoff transition
              // is published as a completed status while the handoff itself is still pending.
              // Waiting on the status alone would race that publication and assert against a
              // half-finished handoff; the terminal outcome is what these assertions need.
              (candidate) =>
                candidate.status === 'completed' && candidate.handoff.outcome !== 'in_progress',
              'the completed handoff',
            ),
          )
        }),
      ),
    )

    expect(detail.handoff).toMatchObject({
      expectedBranch: 'symphony/issue-13',
      remoteBranch: { status: 'observed', name: 'symphony/issue-13' },
      pullRequest: {
        status: 'created',
        number: 61,
        url: 'https://example.test/pull/61',
        state: 'awaiting_checks',
      },
      dispatchLabels: { labels: ['symphony', 'ready'], status: 'not_performed' },
      outcome: 'pull_request_open',
    })
    // Four steps: the transition published before the tracker was asked, then the branch, the
    // pull request, and the dispatch-label step it does not perform.
    expect(detail.timeline.events.map((event) => event.category)).toEqual([
      'handoff',
      'handoff',
      'handoff',
      'handoff',
    ])
    expect(
      detail.timeline.events.map((event) => event.category === 'handoff' && event.status),
    ).toEqual(['pending', 'observed', 'observed', 'not_performed'])
    expect(detail.activity.stallDeadline).toBeNull()
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('publishes the handoff transition before waiting on the tracker', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-handoff-timing-'))
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const issue = {
      ...makeIssue('example/symphony#19', 1, null, ['symphony', 'ready']),
      id: issueId('19'),
    }
    const harness = makeHarness(isolated, () => [issue])
    const factory = makeAgentFactory()
    let releaseHandoff = (): void => undefined
    const handoffReached = new Promise<void>((resolve) => {
      releaseHandoff = resolve
    })
    let blockHandoff = true
    const ports: TestPorts = {
      ...harness.ports,
      runAgent: factory.runAgent,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        handoffCompletedWork: () =>
          blockHandoff
            ? Effect.sync(releaseHandoff).pipe(Effect.zipRight(Effect.never))
            : Effect.succeed({ _tag: 'NoBranch', branchName: 'symphony/issue-19' }),
      }),
    }

    const detail = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          const agent = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/symphony#19'),
          )
          agent.settle('completed')
          yield* Effect.promise(() => handoffReached)
          // The worker has left the running map and the tracker has not answered yet: the
          // published detail must already say so rather than still counting down to stalled.
          return yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/symphony#19',
              (candidate) => candidate.phase.phase === 'handing_off',
              'the handoff transition',
            ),
          )
        }),
      ),
    )

    expect(detail.status).toBe('completed')
    expect(detail.activity.stallDeadline).toBeNull()
    expect(detail.timeline.events.at(-1)).toMatchObject({ category: 'handoff', status: 'pending' })
    blockHandoff = false
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('applies an agent update reported in the same turn the worker settles', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#21', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    const factory = makeAgentFactory()

    const detail = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          const agent = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/symphony#21'),
          )
          // The offer the runner's callback makes has to be in the mailbox by the time the callback
          // returns. If it were only scheduled, the worker's own exit could overtake it and the
          // event loop would drop the update as belonging to a run that has already ended.
          agent.notify('item/completed', { item: { type: 'reasoning' } })
          agent.settle('completed')
          return yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/symphony#21',
              (candidate) => candidate.status !== 'running',
              'the settled record',
            ),
          )
        }),
      ),
    )

    // First in the timeline, ahead of everything the worker's exit records: the update was applied
    // to the live run rather than dropped after it ended.
    expect(detail.timeline.events[0]).toMatchObject({ category: 'reasoning', sequence: 1 })
  })

  it('answers unknown, sessionless, and starting identifiers distinctly', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#14', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    const factory = makeAgentFactory()

    const lookups = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          yield* Effect.promise(() => awaitAgent(factory.agents, 'example/symphony#14'))
          yield* Effect.promise(() =>
            awaitDetail(control, 'example/symphony#14', () => true, 'the running agent'),
          )
          return {
            unknown: readDetail(control, 'example/symphony#404'),
            running: readDetail(control, 'example/symphony#14'),
          }
        }),
      ),
    )

    expect(lookups.unknown._tag).toBe('Unknown')
    expect(lookups.running._tag).toBe('Found')
  })

  it('keeps a retry scheduled before the session starts inspectable', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#16', 1, null, ['symphony', 'ready'])
    // Dispatch preflight fails without the referenced secret, so the retry is scheduled before any
    // agent session exists — and its published link still has to resolve.
    const harness = makeHarness(workflow, () => [issue], undefined, {})
    const factory = makeAgentFactory()

    const lookup = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          return yield* Effect.promise(() =>
            waitUntil(() => {
              const found = readDetail(control, 'example/symphony#16')
              return found._tag === 'Found' && found.detail.status === 'retrying' ? found : null
            }, 'the pre-launch retry to be inspectable'),
          )
        }),
      ),
    )

    expect(lookup._tag).toBe('Found')
    if (lookup._tag === 'Found') {
      expect(lookup.detail.retry?.attempt).toBe(1)
      expect(lookup.detail.retry?.reason).toContain('environment variable')
      expect(lookup.detail.timeline.events.map((entry) => entry.category)).toEqual(['retry'])
      expect(factory.agents.size).toBe(0)
    }
  })

  it('closes the detail of a queued retry an operator pauses away', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#17', 1, null, ['symphony', 'ready'])
    // The same pre-launch failure as above, so the issue is waiting to retry with no session behind
    // it when the pause drops the queued retry.
    const harness = makeHarness(workflow, () => [issue], undefined, {})
    const factory = makeAgentFactory()

    const lookup = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          yield* Effect.promise(() =>
            waitUntil(() => {
              const found = readDetail(control, 'example/symphony#17')
              return found._tag === 'Found' && found.detail.status === 'retrying' ? found : null
            }, 'the pre-launch retry to be inspectable'),
          )

          yield* control.setIssuePaused(17, true)

          return readDetail(control, 'example/symphony#17')
        }),
      ),
    )

    expect(lookup._tag).toBe('Found')
    if (lookup._tag === 'Found') {
      // The retry will never run, so nothing may still describe the agent as waiting for it.
      expect(lookup.detail.status).toBe('completed')
      expect(lookup.detail.retry).toBeNull()
      expect(lookup.detail.phase.phase).toBe('cancelled')
      expect(lookup.detail.attempt.attempts.at(-1)).toMatchObject({
        outcome: 'cancelled',
        reason: 'the operator paused the issue',
      })
      expect(lookup.detail.timeline.events.map((entry) => entry.category)).toEqual([
        'retry',
        'cancellation',
      ])
    }
  })

  it('serves detail while a tracker poll is blocked, and hands out immutable snapshots', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#15', 1, null, ['symphony', 'ready'])
    let blockPolling = false
    const harness = makeHarness(
      workflow,
      () => [issue],
      (_effectiveWorkflow, states) => {
        if (!states.includes('open')) {
          return Effect.succeed([])
        }
        return blockPolling ? Effect.never : Effect.succeed([issue])
      },
    )
    const factory = makeAgentFactory()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          const agent = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/symphony#15'),
          )
          agent.notify('item/completed', { item: { type: 'reasoning' } })
          const before = yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/symphony#15',
              (candidate) => candidate.timeline.events.length === 1,
              'the first event',
            ),
          )
          // The scheduler is now parked inside a poll. A detail read must still answer, and must
          // not be able to change anything the scheduler owns.
          blockPolling = true
          yield* Effect.forkScoped(control.refresh)
          yield* Effect.promise(settle)
          const during = readDetail(control, 'example/symphony#15')
          expect(during._tag).toBe('Found')
          const events = before.timeline.events as unknown as { push: (value: unknown) => number }
          expect(() => events.push('tampered')).toThrow()
          const after = readDetail(control, 'example/symphony#15')
          return { during, after }
        }),
      ),
    )

    expect(observed.after._tag).toBe('Found')
    if (observed.after._tag === 'Found') {
      expect(observed.after.detail.timeline.events).toHaveLength(1)
      expect(observed.after.detail.activity.elapsedMs).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('aged-out agent detail', (): void => {
  it('keeps reporting an evicted session as completed on later publications', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-aged-out-'))
    const total = retainedCompletedDetails + 1
    const issues = Array.from({ length: total }, (_unused, index) => ({
      ...makeIssue(`example/symphony#${String(index + 20)}`, 1, null, ['symphony', 'ready']),
      id: issueId(String(index + 20)),
    }))
    const isolated: Workflow = {
      ...workflow,
      config: {
        ...workflow.config,
        workspaceRoot,
        agent: { ...workflow.config.agent, maxConcurrentAgents: total },
      },
    }
    const harness = makeHarness(isolated, () => issues)
    const factory = makeAgentFactory()
    const ports: TestPorts = {
      ...harness.ports,
      runAgent: factory.runAgent,
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
        handoffCompletedWork: (issue) =>
          Effect.succeed({
            _tag: 'PullRequest',
            branchName: `symphony/issue-${issue.id}`,
            pullRequestUrl: `https://example.test/pull/${issue.id}`,
            pullRequestNumber: Number(issue.id),
            created: true,
          }),
      }),
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          for (const issue of issues) {
            const agent = yield* Effect.promise(() => awaitAgent(factory.agents, issue.identifier))
            agent.settle('completed')
          }
          const evicted = yield* Effect.promise(() =>
            waitUntil(() => {
              const aged = issues.filter(
                (issue) => readDetail(control, issue.identifier)._tag === 'Completed',
              )
              return aged.length === 1 ? (aged[0]?.identifier ?? null) : null
            }, 'the oldest detail to age out'),
          )
          // Any later publication must not downgrade the aged-out answer to "no session".
          yield* control.setIssuePaused(9_999, true)
          return { evicted, after: readDetail(control, evicted) }
        }),
      ),
    )

    expect(observed.after).toEqual({ _tag: 'Completed', identifier: observed.evicted })
    await rm(workspaceRoot, { force: true, recursive: true })
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
  payload: { kind: 'none' },
  ...overrides,
})

describe('session telemetry accounting', (): void => {
  it('tracks metadata and rate limits without double-counting repeated absolute totals', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#16', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
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
    const ports: TestPorts = {
      ...harness.ports,
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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
    const ports: TestPorts = {
      ...harness.ports,
      makeWorkspaces: (settings) => ({
        ...harness.ports.makeWorkspaces(settings),
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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
    const ports: TestPorts = {
      ...harness.ports,
      makeWorkspaces: (settings) => ({
        ...harness.ports.makeWorkspaces(settings),
        afterRun: () =>
          Effect.sync(() => {
            afterRunCount += 1
          }),
      }),
      makeCodeReview: (provider) => ({
        ...requireCodeReview(harness.ports, provider),
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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

  it('uses continuation turns when the tracker has no CodeReviewPort and handoff is disabled', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#139', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    const { makeCodeReview: omittedCodeReview, ...trackerOnlyPorts } = harness.ports
    void omittedCodeReview
    const ports: TestPorts = {
      ...trackerOnlyPorts,
      runAgent: () =>
        Effect.succeed({ threadId: 'thread-neutral', turnId: 'turn-neutral', turnCount: 1 }),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let snapshot = yield* control.snapshot
          while (snapshot.retrying.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          expect(snapshot.handoffs).toEqual([])
          expect(snapshot.retrying[0]).toMatchObject({
            issueId: issue.id,
            attempt: 1,
            error: null,
          })
        }),
      ),
    )
  })

  it('preserves the persisted handoff store while handoff is disabled', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-disabled-handoff-'))
    const storePath = join(workspaceRoot, '.symphony', 'handoffs.json')
    const persisted = {
      issueId: issueId('75'),
      identifier: issueIdentifier('example/symphony#75'),
      pullRequestUrl: 'https://github.test/example/symphony/pull/95',
      branchName: 'symphony/issue-75',
      state: 'awaiting_checks' as const,
      headSha: 'persisted-head',
      reason: null,
      repairAttempts: 0,
      observedAt: new Date(0).toISOString(),
    }
    await Effect.runPromise(saveHandoffs(storePath, [persisted]))
    const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const harness = makeHarness(isolated)
    const { makeCodeReview: omittedCodeReview, ...trackerOnlyPorts } = harness.ports
    void omittedCodeReview

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', trackerOnlyPorts)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(snapshot.handoffs).toEqual([])
    await expect(Effect.runPromise(loadHandoffs(storePath))).resolves.toEqual([persisted])
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('rejects enabled handoff when the provider does not supply CodeReviewPort', async (): Promise<void> => {
    const harness = makeHarness(workflow)
    const ports: TestPorts = {
      ...harness.ports,
      makeCodeReview: () => null,
    }

    const result = await Effect.runPromise(
      Effect.either(Effect.scoped(startTestOrchestrator('/tmp/WORKFLOW.md', ports))),
    )

    expect(result).toMatchObject({
      _tag: 'Left',
      left: {
        category: 'invalid_config',
        message:
          'pull-request handoff is enabled, but tracker provider github does not supply CodeReviewPort',
      },
    })
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
    const ports: TestPorts = {
      ...harness.ports,
      makeWorkspaces: (settings) => ({
        ...harness.ports.makeWorkspaces(settings),
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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

  it('publishes the saturated issue states and the agents whose detail will answer', async (): Promise<void> => {
    const perStateWorkflow: Workflow = {
      ...workflow,
      config: {
        ...workflow.config,
        agent: {
          ...workflow.config.agent,
          maxConcurrentAgents: 4,
          // Open issues get a narrower cap than the host as a whole, so the state saturates while
          // there is still global capacity — the case a console reading only the global limit
          // would report as a free slot.
          maxConcurrentAgentsByState: new Map([['open', 1]]),
        },
      },
    }
    const issue = makeIssue('example/symphony#26', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(perStateWorkflow, () => [issue])
    let resolveStarted = (): void => undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const ports: TestPorts = {
      ...harness.ports,
      runAgent: () => Effect.sync(resolveStarted).pipe(Effect.zipRight(Effect.never)),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* Effect.promise(() => started)

          const snapshot = yield* control.snapshot
          expect(snapshot.running).toHaveLength(1)
          expect(snapshot.maxConcurrentAgents).toBe(4)
          expect(snapshot.saturatedStates).toEqual(['open'])
          // The running agent's detail resource will answer, so the console may offer to inspect it.
          expect(snapshot.inspectableAgents).toEqual([issue.identifier])
        }),
      ),
    )
  })

  it('reports no saturated state when the workflow sets no per-state limit', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#27', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    let resolveStarted = (): void => undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const ports: TestPorts = {
      ...harness.ports,
      runAgent: () => Effect.sync(resolveStarted).pipe(Effect.zipRight(Effect.never)),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* Effect.promise(() => started)

          expect((yield* control.snapshot).saturatedStates).toEqual([])
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
    const ports: TestPorts = {
      ...harness.ports,
      runAgent: () => Effect.sync(resolveStarted).pipe(Effect.zipRight(Effect.never)),
    }

    await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* Effect.promise(() => started)
          currentIssue = { ...currentIssue, title: 'Updated while active' }

          yield* control.refresh

          const snapshot = yield* control.snapshot
          expect(snapshot.running).toHaveLength(1)
          expect(snapshot.running[0]).toMatchObject({
            issueId: currentIssue.id,
            title: 'Updated while active',
          })
          // The stall deadline is published absolutely so the console can decide the agent has
          // gone quiet without waiting for a later snapshot to say so.
          const deadline = snapshot.running[0]?.stallDeadline ?? ''
          expect(Number.isNaN(Date.parse(deadline))).toBe(false)
          expect(new Date(deadline).getTime()).toBe(
            new Date(
              snapshot.running[0]?.lastEventAt ?? snapshot.running[0]?.startedAt ?? '',
            ).getTime() + workflow.config.codex.stallTimeoutMs,
          )
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
    const ports: TestPorts = {
      ...harness.ports,
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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
    const ports: TestPorts = {
      ...harness.ports,
      makeTracker: (provider) => ({
        ...harness.ports.makeTracker(provider),
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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

  it('finalizes a queued retry rejected by the tracker policy', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#27', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    const ports: TestPorts = {
      ...harness.ports,
      makeTracker: (provider) => ({
        ...harness.ports.makeTracker(provider),
        fetchIssuesByIds: () =>
          Effect.fail(
            new TrackerError({
              category: 'tracker_response',
              message: 'retry refresh was rejected',
              retryable: false,
            }),
          ),
      }),
      runAgent: () =>
        Effect.fail(new AgentError({ category: 'process_exited', message: 'test failure' })),
    }

    const lookup = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          while ((yield* control.snapshot).retrying.length === 0) {
            yield* Effect.yieldNow()
          }

          yield* TestClock.adjust(10_000)
          yield* Effect.yieldNow()

          return readDetail(control, issue.identifier)
        }),
      ),
    )

    expect(lookup._tag).toBe('Found')
    if (lookup._tag === 'Found') {
      expect(lookup.detail.status).toBe('completed')
      expect(lookup.detail.retry).toBeNull()
      expect(lookup.detail.phase.phase).toBe('cancelled')
      expect(lookup.detail.attempt.attempts.at(-1)).toMatchObject({
        outcome: 'cancelled',
        reason: 'retry refresh failed: retry refresh was rejected',
      })
      expect(lookup.detail.timeline.events.map((entry) => entry.category)).toContain('cancellation')
    }
  })

  it('retains ended usage while a retry starts a fresh absolute counter', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#17', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    let runCount = 0
    let resolveSecondRun = (): void => undefined
    const secondRun = new Promise<void>((resolve) => {
      resolveSecondRun = resolve
    })
    const ports: TestPorts = {
      ...harness.ports,
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
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
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
