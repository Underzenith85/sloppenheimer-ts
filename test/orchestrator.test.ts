Warning: truncated output (original token count: 100509)
Total output lines: 10303

import { makeDurableHost } from '@sloppenheimer/core/core/durable/live-journal.js'
import { WorkflowComposition, WorkflowStore } from '@sloppenheimer/core/ports/workflow-store.js'
import { openWorkflowStore } from '@sloppenheimer/adapter-node/workflow-store.js'
import type { FileSystem } from '@effect/platform'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  Scope,
  Stream,
  TestClock,
} from 'effect'
import { describe, expect } from 'vitest'

import { githubProviderOf, githubTrackerProvider } from '@sloppenheimer/adapter-github'
import {
  telemetryFrom,
  type AgentEvent,
  type AgentResult,
} from '@sloppenheimer/adapter-codex/codex.js'
import {
  cyclicIssueIdentifiers,
  findDependencyCycles,
} from '@sloppenheimer/core/domain/dependencies.js'
import {
  issueId,
  issueIdentifier,
  type BlockerRef,
  type Issue,
  type IssueId,
  type JsonObject,
  type Workspace,
} from '@sloppenheimer/core/domain/domain.js'
import {
  AgentError,
  SourceControlError,
  TrackerError,
  WorkflowError,
  WorkspaceError,
  type CompletionStoreError,
  type HandoffStoreError,
} from '@sloppenheimer/core/domain/errors.js'
import {
  loadHandoffs as loadHandoffsAgainstFileSystem,
  saveHandoffs as saveHandoffsAgainstFileSystem,
} from '@sloppenheimer/core/core/handoff-store.js'
import {
  loadCompletions as loadCompletionsAgainstFileSystem,
  saveCompletions as saveCompletionsAgainstFileSystem,
} from '@sloppenheimer/core/core/completion-store.js'
import type {
  CodexReviewObservation,
  HandoffSnapshot,
  PullRequestObservation,
} from '@sloppenheimer/core/domain/handoff.js'
import {
  issueIsRoutable,
  retainedCompletedDetails,
  sortIssues,
  startOrchestrator,
  type AgentDetailLookup,
  type CompletedSnapshot,
  type OrchestratorControl,
  type OrchestratorServices,
} from '@sloppenheimer/core'
import { deliveryAttemptLimit } from '@sloppenheimer/core/core/retry.js'
import { makeRedactor } from '@sloppenheimer/core/support/redaction.js'
import { normalizePayload } from '@sloppenheimer/adapter-codex/payload.js'
import type { AgentDetailSnapshot } from '@sloppenheimer/core/telemetry.js'
import {
  CodeReviewFactory,
  SourceControlFactory,
  layerAgentRunner,
  layerCodeReviewPorts,
  layerSourceControlPorts,
  layerPorts,
  layerWorkflowLoader,
  layerWorkflowWatcher,
  portsConfiguration,
  TrackerFactory,
  WorkspaceManagerFactory,
  type AdapterServices,
  type AgentLaunch,
  type AgentRunnerPort,
  type CodeReviewPort,
  type SourceControlPort,
  type SourceControlTarget,
  type PortsConfiguration,
  type TrackerPort,
  type WorkspaceManagerPort,
  type WorkspaceSettings,
} from '@sloppenheimer/core'
import type { Workflow } from '@sloppenheimer/core/config/workflow.js'
import type { WorkspaceRelease, WorkspaceRun } from '@sloppenheimer/core/domain/workspace-lease.js'
import type { WorkspacePruneReport } from '@sloppenheimer/core/domain/workspace-retention.js'
import { preflightWorkflow } from '../src/config/workflow.js'
import type { PreflightResult } from '@sloppenheimer/core/ports/workflow.js'
import { runWithEnvironment, withEnvironment } from './harness/environment.js'
import { stubProvider } from './harness/stub-tracker-provider.js'
import { hostFileSystem } from './harness/filesystem.js'
import { anIssue, anOpenPullRequest, changedWorktree, cleanWorktree } from './harness/fixtures.js'

/**
 * A temp directory the enclosing scope owns, for the runs that read and write a real handoff store.
 * Released on failure, defect and interruption alike, which a `rm` trailing the assertions cannot
 * promise: an assertion that throws aborts the test body before it runs.
 */
const isolatedWorkspaceRoot = (prefix: string): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    (root) => Effect.promise(() => rm(root, { force: true, recursive: true })),
  )

/**
 * The handoff store reads and writes through `FileSystem`. Every assertion below inspects the real
 * store the orchestrator wrote, so the host's is bound here the way the composition root binds it.
 */
const onHostFileSystem = <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, Error, Exclude<Requirements, FileSystem.FileSystem>> =>
  Effect.provide(effect, hostFileSystem)

const loadHandoffs = (path: string): Effect.Effect<readonly HandoffSnapshot[], HandoffStoreError> =>
  onHostFileSystem(loadHandoffsAgainstFileSystem(path))

const saveHandoffs = (
  path: string,
  handoffs: readonly HandoffSnapshot[],
): Effect.Effect<void, HandoffStoreError> =>
  onHostFileSystem(saveHandoffsAgainstFileSystem(path, handoffs))

const loadCompletions = (
  path: string,
): Effect.Effect<readonly CompletedSnapshot[], CompletionStoreError> =>
  onHostFileSystem(loadCompletionsAgainstFileSystem(path))

const saveCompletions = (
  path: string,
  completions: readonly CompletedSnapshot[],
): Effect.Effect<void, CompletionStoreError> =>
  onHostFileSystem(saveCompletionsAgainstFileSystem(path, completions))
import type { HostToolSession } from '@sloppenheimer/core/domain/host-tools.js'
import type { ValidatedTrackerProvider } from '@sloppenheimer/core/domain/tracker-provider.js'
import {
  auroraEvents,
  auroraRunner,
  auroraRunnerAdapter,
  auroraRunners,
  stubRunner,
} from './harness/alien-agent-runner.js'

const makeIssue = (
  identifier: string,
  priority: number | null,
  createdAt: string | null,
  labels: readonly string[] = ['sloppenheimer'],
  blockedBy: readonly BlockerRef[] = [],
): Issue =>
  anIssue({
    identifier: issueIdentifier(identifier),
    priority,
    labels,
    blockedBy,
    createdAt: createdAt === null ? null : new Date(createdAt),
  })

const testEnvironment: Record<string, string> = { SLOPPENHEIMER_TEST_TOKEN: 'secret' }

const workflow: Workflow = {
  path: '/tmp/WORKFLOW.md',
  fingerprint: 'test',
  promptTemplate: 'test',
  // The suite runs against a runner that shares no vocabulary with Codex: its kind, its settings
  // and the event names below are all Aurora's. Anything in the core still reading one backend's
  // names fails here rather than passing because Codex happens to be what it was shaped around.
  runner: auroraRunner(),
  tracker: runWithEnvironment(
    githubTrackerProvider.validate({
      owner: 'example',
      repository: 'sloppenheimer',
      token: '$SLOPPENHEIMER_TEST_TOKEN',
    }),
    testEnvironment,
  ),
  config: {
    tracker: {
      kind: 'github',
      provider: {
        owner: 'example',
        repository: 'sloppenheimer',
        token: '$SLOPPENHEIMER_TEST_TOKEN',
      },
      requiredLabels: ['sloppenheimer', 'ready'],
      activeStates: ['open'],
      terminalStates: ['closed'],
    },
    pollingIntervalMs: 30_000,
    workspaceRoot: '/tmp/sloppenheimer',
    workspaceRetainedLimit: 3,
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
    runner: {
      command: 'codex app-server',
      turnTimeoutMs: 60_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 30_000,
      settings: { tempo: 'largo' },
    },
    serverPort: null,
    // Stated rather than defaulted: these runs compose the code-review services explicitly, so the
    // workflow they run under says the pull-request handoff extension is enabled.
    handoffEnabled: true,
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

  it('matches required labels case-insensitively', (): void => {
    expect(
      issueIsRoutable(
        makeIssue('GH-1', 1, null, ['Ready', 'SLOPPENHEIMER']),
        workflow.config.tracker,
      ),
    ).toBe(true)
    expect(
      issueIsRoutable(makeIssue('GH-2', 1, null, ['sloppenheimer']), workflow.config.tracker),
    ).toBe(false)
  })

  /**
   * The rules reaching this predicate are not always normalized. The workflow loader lowercases
   * `required_labels` on the way in, but an `ExecutionSnapshot` copies whatever it was handed, and
   * the startup recovery scan used to normalize at the point of use where the scheduler did not —
   * so the same label matched in one place and was missed in the other.
   */
  it('matches a required label the rules did not arrive normalized', (): void => {
    const rules = {
      requiredLabels: [' Ready '],
      activeStates: ['open'],
      terminalStates: ['closed'],
    }

    expect(issueIsRoutable(makeIssue('GH-1', 1, null, ['ready']), rules)).toBe(true)
  })

  it('refuses an empty required label rather than skipping it', (): void => {
    expect(issueIsRoutable(makeIssue('GH-1', 1, null, ['ready']), { requiredLabels: ['  '] })).toBe(
      false,
    )
  })

  it('rejects a provider record marked non-dispatchable at the scheduler boundary', (): void => {
    const issue = {
      ...makeIssue('GH-3', 1, null, ['sloppenheimer', 'ready']),
      dispatchable: false,
    }

    expect(issueIsRoutable(issue, workflow.config.tracker)).toBe(false)
  })

  it('leaves blocker metadata to adapter-supplied dispatchability', (): void => {
    const openBlocker: BlockerRef = {
      id: '101',
      identifier: issueIdentifier('example/sloppenheimer#1'),
      title: 'Foundation',
      state: 'open',
      url: 'https://github.com/example/sloppenheimer/issues/1',
    }
    const blocked = makeIssue(
      'example/sloppenheimer#2',
      1,
      null,
      ['ready', 'sloppenheimer'],
      [openBlocker],
    )
    const ready = { ...blocked, blockedBy: [{ ...openBlocker, state: 'closed' }] }

    expect(issueIsRoutable(blocked, workflow.config.tracker)).toBe(true)
    expect(issueIsRoutable(ready, workflow.config.tracker)).toBe(true)
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
        `example/sloppenheimer#${String(number)}`,
        null,
        null,
        ['ready', 'sloppenheimer'],
        blockers.map((number) => blocker(`example/sloppenheimer#${String(number)}`)),
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
        members: ['example/sloppenheimer#6', 'example/sloppenheimer#7'],
        message: 'Dependency cycle members: example/sloppenheimer#6, example/sloppenheimer#7',
      },
    ])
    expect([...cyclicIssueIdentifiers(graph)]).toEqual([
      'example/sloppenheimer#6',
      'example/sloppenheimer#7',
    ])
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
  preflightWorkflow: (workflow: Workflow) => Effect.Effect<PreflightResult, WorkflowError>
  makeTracker: (provider: ValidatedTrackerProvider) => TrackerPort
  /** Omit to compose no code-review services at all, which disables pull-request handoff. */
  makeCodeReview?: (provider: ValidatedTrackerProvider) => CodeReviewPort | null
  makeSourceControl?: (provider: ValidatedTrackerProvider) => SourceControlPort | null
  makeWorkspaces: (settings: WorkspaceSettings) => WorkspaceManagerPort
  runAgent: AgentRunnerPort['run']
  watchWorkflow: (path: string, onChange: () => void) => void
  /** The variables the run's `ConfigProvider` serves. Mutating one rotates that credential. */
  environment: Record<string, string>
  /** Observes the watcher's own teardown, which the stream's scope owns. */
  onWatchReleased?: (path: string) => void
  onTrackerReleased?: (provider: ValidatedTrackerProvider) => void
  onSourceControlReleased?: (provider: ValidatedTrackerProvider) => void
  onWorkspacesReleased?: (settings: WorkspaceSettings) => void
}>

const layerTestAdapters = (ports: TestPorts): Layer.Layer<AdapterServices> =>
  Layer.mergeAll(
    layerAgentRunner({ kind: auroraRunnerAdapter.kind, run: ports.runAgent }),
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
      preflight: ports.preflightWorkflow,
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

const layerTestPorts = (
  ports: TestPorts,
): Layer.Layer<OrchestratorServices, TrackerError | SourceControlError> => {
  /**
   * The issues an agent has run for, which is what the stub source control reads their worktrees
   * as.
   *
   * A workspace is clean until an agent edits it, and only that issue's own. Saying so matters: the
   * host publishes only what it can see, and workspace examination reads a prepared workspace that
   * inspects as changed as work a previous process never published. A stub that read every
   * workspace as changed once any agent had run would have each pass republishing workspaces no
   * agent had touched.
   */
  const launched = new Set<string>()
  const tracked: TestPorts = {
    ...ports,
    runAgent: (launch) => {
      launched.add(launch.issue.id)
      return ports.runAgent(launch)
    },
  }
  const editedByAnAgent = (branchName: string): boolean =>
    [...launched].some((id) => branchName === `sloppenheimer/issue-${id}`)
  // The orchestrator reads and writes the handoff store through `FileSystem`; the harness binds the
  // host's, so a test drives real files exactly as the composition root does.
  const base = Layer.mergeAll(
    layerPorts(tracked.configuration, layerTestAdapters(tracked)),
    hostFileSystem,
  )
  const makeCodeReview = ports.makeCodeReview
  if (makeCodeReview === undefined) {
    const makeSourceControl = ports.makeSourceControl
    return makeSourceControl === undefined
      ? base
      : Layer.merge(
          base,
          layerSourceControlPorts(
            ports.configuration,
            Layer.succeed(SourceControlFactory, {
              make: (provider) => Effect.sync(() => makeSourceControl(provider)),
            }),
          ),
        )
  }
  const sourceControl: SourceControlPort = {
    prepare: (_issue, workspace, target) =>
      Effect.succeed({
        workspace,
        target,
        baseBranch: 'main',
        baseSha: 'base-head',
        baselineSha: target._tag === 'Repair' ? target.expectedHeadSha : 'base-head',
        expectedRemoteHead:
          target._tag === 'Repair' ? Option.some(target.expectedHeadSha) : Option.none(),
      }),
    inspect: (prepared) =>
      Effect.succeed(
        editedByAnAgent(prepared.target.branchName)
          ? changedWorktree
          : cleanWorktree(prepared.baselineSha),
      ),
    publish: (_issue, prepared) =>
      Effect.succeed({
        _tag: 'Published',
        branchName: prepared.target.branchName,
        headSha: 'published-head',
        commitCreated: true,
      }),
    rebase: (_issue, prepared) =>
      Effect.succeed({
        _tag: 'Published',
        branchName: prepared.target.branchName,
        headSha: 'rebased-head',
        commitCreated: false,
      }),
  }
  const makeSourceControl = ports.makeSourceControl
  return Layer.mergeAll(
    base,
    layerCodeReviewPorts(
      ports.configuration,
      Layer.succeed(CodeReviewFactory, {
        make: (provider) => Effect.succeed(makeCodeReview(provider)),
      }),
    ),
    layerSourceControlPorts(
      ports.configuration,
      Layer.succeed(SourceControlFactory, {
        make: (provider) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              makeSourceControl === undefined ? sourceControl : makeSourceControl(provider),
            ),
            () => Effect.sync(() => ports.onSourceControlReleased?.(provider)),
          ),
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
): Effect.Effect<
  OrchestratorControl,
  WorkflowError | TrackerError | SourceControlError,
  Scope.Scope
> =>
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
  refuseNextPreflight: (message: string) => void
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
  let nextPreflightFailure: WorkflowError | null = null
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
    preflightWorkflow: (workflow) => {
      const failure = nextPreflightFailure
      nextPreflightFailure = null
      return failure === null ? preflightWorkflow(workflow) : Effect.fail(failure)
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
      handoffCompletedWork: () =>
        Effect.succeed({ _tag: 'NoBranch', branchName: 'sloppenheimer/test' }),
      findExistingHandoff: () =>
        Effect.succeed({ _tag: 'NoBranch', branchName: 'sloppenheimer/test' }),
      inspectPullRequest: () => Effect.die('unused'),
      mergePullRequest: () => Effect.die('unused'),
      requestPullRequestReview: () => Effect.die('unused'),
      resolveReviewThreads: () => Effect.die('unused'),
    }),
    makeWorkspaces: (settings) => {
      workspaceSettings.push(settings)
      return {
        // A real bracket, like the Node manager's: the release runs however the use ended, so a
        // test can observe what a run's workspace was released as.
        withLeasedWorkspace: (run, use, disposition) =>
          Effect.acquireUseRelease(
            Effect.succeed({
              path: `/tmp/sloppenheimer-test/run-${String(run.runId)}`,
              key: 'test',
            }),
            (workspace) => use(workspace),
            (_workspace, exit) =>
              Effect.sync(() => {
                disposition(exit)
              }),
          ),
        exists: () => Effect.succeed(true),
        beforeRun: () => Effect.void,
        afterRun: () => Effect.void,
        remove: () => Effect.void,
        prune: () => Effect.succeed({ count: 0, bytes: 0, evicted: 0 }),
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
    refuseNextPreflight: (message) => {
      nextPreflightFailure = new WorkflowError({ category: 'invalid_config', message })
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

/** Models a validation race after the tick gate, without making the whole tick invalid. */
const armFirstRepairDispatchRefusal = (harness: TestHarness): (() => void) => {
  let armed = false
  return () => {
    if (armed) {
      return
    }
    armed = true
    harness.refuseNextPreflight('repair dispatch validation changed after the tick preflight')
  }
}

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

const repairObservation = (number: number, headSha: string): PullRequestObservation =>
  anOpenPullRequest({
    number,
    url: 'https://github.test/example/sloppenheimer/pull/65',
    headSha,
    mergeable: false,
    mergeState: 'dirty',
    checks: [],
    codexReview: { headSha: headSha, status: 'completed' },
  })

/**
 * A pull request GitHub reports as merely out of date: the checks pass, nothing conflicts, and the
 * head has been reviewed. Nothing about the change is an agent's to fix.
 */
const behindObservation = (number: number, headSha: string): PullRequestObservation =>
  anOpenPullRequest({
    number,
    url: 'https://github.test/example/sloppenheimer/pull/65',
    headSha,
    mergeable: true,
    mergeState: 'behind',
    codexReview: { headSha: headSha, status: 'completed' },
  })

/**
 * Source control for a pull request the host rebases: the preparation a repair gets, a worktree
 * nothing has edited, and no publication -- a behind branch is rebased, never published.
 */
const behindSourceControl = (rebase: SourceControlPort['rebase']): SourceControlPort => ({
  prepare: (_candidate, workspace, target) =>
    Effect.succeed({
      workspace,
      target,
      baseBranch: 'main',
      baseSha: 'protected-main',
      baselineSha: target._tag === 'Repair' ? target.expectedHeadSha : 'protected-main',
      expectedRemoteHead:
        target._tag === 'Repair' ? Option.some(target.expectedHeadSha) : Option.none(),
    }),
  inspect: (prepared) => Effect.succeed(cleanWorktree(prepared.baselineSha)),
  publish: () => Effect.die('a behind branch is rebased, never published'),
  rebase,
})

const saveRepairHandoff = (
  path: string,
  issue: Issue,
  headSha: string,
): Effect.Effect<void, HandoffStoreError> =>
  saveHandoffs(path, [
    {
      issueId: issue.id,
      identifier: issue.identifier,
      pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
      branchName: 'sloppenheimer/issue-20',
      state: 'repair_needed',
      headSha,
      reason: 'The pull request conflicts with protected main',
      repairAttempts: 0,
      repairHeadShas: [],
      repairStartedHeadSha: null,
      reviewRequestedHeadSha: headSha,
      reviewCompletedHeadSha: headSha,
      observedAt: new Date(0).toISOString(),
    },
  ])

describe('host-owned source-control dispatch', (): void => {
  it.effect('publishes a normal run without exposing a credential to the agent launch', () =>
    Effect.gen(function* () {
      const issue = {
        ...makeIssue('example/sloppenheimer#165', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('165'),
      }
      const harness = makeHarness(workflow, () => [issue])
      const targets: SourceControlTarget[] = []
      const publications: string[] = []
      // The worktree is clean until this run's agent has edited it, so startup delivery recovery
      // sees nothing to republish and the publication below is the one this test dispatched.
      let launched = false
      let launchSecretNames: readonly string[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeTracker: (provider) => ({
          ...harness.ports.makeTracker(provider),
          secretEnvironmentNames: ['SLOPPENHEIMER_TEST_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'],
        }),
        // A host with no workspace for this issue yet, so startup delivery recovery has nothing to
        // examine and the preparation below is the one this dispatch made.
        makeWorkspaces: (settings) => ({
          ...harness.ports.makeWorkspaces(settings),
          exists: () => Effect.succeed(false),
        }),
        makeSourceControl: () => ({
          prepare: (_candidate, workspace, target) => {
            targets.push(target)
            return Effect.succeed({
              workspace,
              target,
              baseBranch: 'main',
              baseSha: 'protected-main',
              baselineSha: 'protected-main',
              expectedRemoteHead: Option.none(),
            })
          },
          inspect: (prepared) =>
            Effect.succeed(launched ? changedWorktree : cleanWorktree(prepared.baselineSha)),
          publish: (_candidate, prepared) => {
            publications.push(prepared.target.branchName)
            return Effect.succeed({
              _tag: 'Published',
              branchName: prepared.target.branchName,
              headSha: 'published-head',
              commitCreated: true,
            })
          },
          rebase: () => Effect.die('no test here rebases a pull request'),
        }),
        runAgent: (launch) => {
          launched = true
          launchSecretNames = launch.secretEnvironmentNames
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          while (publications.length === 0) {
            yield* Effect.yieldNow()
          }
        }),
      )

      expect(targets).toEqual([{ _tag: 'Normal', branchName: 'sloppenheimer/issue-165' }])
      expect(publications).toEqual(['sloppenheimer/issue-165'])
      expect(launchSecretNames).toEqual(
        expect.arrayContaining(['SLOPPENHEIMER_TEST_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']),
      )
    }),
  )

  it.scoped('prepares and publishes a repair from the handoff exact head', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-source-control-repair-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#165', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('165'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveRepairHandoff(join(workspaceRoot, '.sloppenheimer', 'handoffs.json'), issue, head)
      const harness = makeHarness(isolated, () => [issue])
      const targets: SourceControlTarget[] = []
      const publications: string[] = []
      let launched = false
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        makeSourceControl: () => ({
          prepare: (_candidate, workspace, target) => {
            targets.push(target)
            return Effect.succeed({
              workspace,
              target,
              baseBranch: 'main',
              baseSha: 'protected-main',
              baselineSha: head,
              expectedRemoteHead: Option.some(head),
            })
          },
          inspect: (prepared) =>
            Effect.succeed(launched ? changedWorktree : cleanWorktree(prepared.baselineSha)),
          publish: (_candidate, prepared) => {
            publications.push(prepared.target.branchName)
            return Effect.succeed({
              _tag: 'Published',
              branchName: prepared.target.branchName,
              headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              commitCreated: true,
            })
          },
          rebase: () => Effect.die('no test here rebases a pull request'),
        }),
        runAgent: () => {
          launched = true
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          while (publications.length === 0) {
            yield* Effect.yieldNow()
          }
        }),
      )

      expect(targets[0]).toEqual({
        _tag: 'Repair',
        branchName: 'sloppenheimer/issue-20',
        expectedHeadSha: head,
      })
      expect(publications).toEqual(['sloppenheimer/issue-20'])
    }),
  )
})

/**
 * Issue #167: a turn that reported `completed` is not a claim that any work exists, nor that it
 * reached the remote. These drive the exact sequence PR #152 hit — the agent implements the change,
 * the turn completes, and Git delivery fails — and assert that Sloppenheimer keeps the work and
 * says what is wrong, rather than reading the unchanged remote as an agent that achieved nothing.
 */
describe('agent turn completion separated from work publication', (): void => {
  const deliveryFailure = (
    overrides: Partial<ConstructorParameters<typeof SourceControlError>[0]> = {},
  ): SourceControlError =>
    new SourceControlError({
      category: 'publication_failed',
      message: 'read-only .git metadata',
      retryable: true,
      worktreePreserved: true,
      ...overrides,
    })

  /** A host source control whose worktree holds work once the agent has run, and cannot publish. */
  const failingSourceControl = (
    hasWork: () => boolean,
    publish: SourceControlPort['publish'],
  ): SourceControlPort => ({
    prepare: (_candidate, workspace, target) =>
      Effect.succeed({
        workspace,
        target,
        baseBranch: 'main',
        baseSha: 'protected-main',
        baselineSha: target._tag === 'Repair' ? target.expectedHeadSha : 'protected-main',
        expectedRemoteHead:
          target._tag === 'Repair' ? Option.some(target.expectedHeadSha) : Option.none(),
      }),
    inspect: (prepared) =>
      Effect.succeed(hasWork() ? changedWorktree : cleanWorktree(prepared.baselineSha)),
    publish,
    rebase: () => Effect.die('no test here rebases a pull request'),
  })

  it.scoped(
    'holds a failed verification without repeating publication or coding until resumed',
    () =>
      Effect.gen(function* () {
        const issue = {
          ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
          id: issueId('167'),
        }
        const harness = makeHarness(workflow, () => [issue])
        let launches = 0
        let publications = 0
        const ports: TestPorts = {
          ...harness.ports,
          makeSourceControl: () =>
            failingSourceControl(
              () => launches > 0,
              () => {
                publications += 1
                return Effect.fail(
                  deliveryFailure({ category: 'verification_failed', retryable: false }),
                )
              },
            ),
          runAgent: () => {
            launches += 1
            return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
          },
        }
        const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
        while ((yield* control.snapshot).delivering.length === 0) {
          yield* Effect.yieldNow()
        }
        yield* TestClock.adjust(60_000)
        expect(launches).toBe(1)
        expect(publications).toBe(1)
        expect((yield* control.snapshot).retrying).toEqual([])
        expect((yield* control.snapshot).delivering[0]?.interventionRequired).toBe(true)
        yield* control.setIssuePaused(167, false)
        yield* TestClock.adjust(20_000)
        while (publications < 2) {
          yield* Effect.yieldNow()
        }
        expect(launches).toBe(1)
      }),
  )

  it.scoped(
    'keeps partial work after an agent error instead of launching a replacement coder',
    () =>
      Effect.gen(function* () {
        const issue = {
          ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
          id: issueId('167'),
        }
        const configured: Workflow = {
          ...workflow,
          config: { ...workflow.config, verification: { command: 'pnpm check', timeoutMs: 1_000 } },
        }
        const harness = makeHarness(configured, () => [issue])
        let launches = 0
        const ports: TestPorts = {
          ...harness.ports,
          makeSourceControl: () =>
            failingSourceControl(
              () => launches > 0,
              () => Effect.die('partial work must not be automatically published'),
            ),
          runAgent: () => {
            launches += 1
            return Effect.fail(
              new AgentError({ category: 'turn_timeout', message: 'session stopped' }),
            )
          },
        }
        const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
        while ((yield* control.snapshot).delivering.length === 0) {
          yield* Effect.yieldNow()
        }
        yield* TestClock.adjust(60_000)
        expect(launches).toBe(1)
        expect((yield* control.snapshot).retrying).toEqual([])
        expect((yield* control.snapshot).delivering[0]).toMatchObject({
          category: 'candidate_partial',
          interventionRequired: true,
        })
      }),
  )

  it.scoped('retains the work a failed publication left, rather than retrying the agent', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-delivery-retained-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      const harness = makeHarness(isolated, () => [issue])
      let launched = 0
      const ports: TestPorts = {
        ...harness.ports,
        makeSourceControl: () =>
          failingSourceControl(
            () => launched > 0,
            () => Effect.fail(deliveryFailure()),
          ),
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let snapshot = yield* control.snapshot
          while (snapshot.delivering.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          // The turn completed and the change exists. Neither "running", nor "retrying the agent",
          // nor "completed without changing the head": the publication is what is outstanding.
          expect(snapshot.running).toEqual([])
          expect(snapshot.retrying).toEqual([])
          expect(snapshot.counts.delivering).toBe(1)
          expect(snapshot.delivering[0]).toMatchObject({
            issueId: issue.id,
            identifier: issue.identifier,
            branchName: 'sloppenheimer/issue-167',
            attempt: 1,
            category: 'publication_failed',
            reason: 'read-only .git metadata',
            repairRun: false,
          })
          expect(launched).toBe(1)

          const lookup = yield* control.agentDetail(issue.identifier)
          expect(lookup._tag).toBe('Found')
          if (lookup._tag === 'Found') {
            expect(lookup.detail.handoff.publication).toMatchObject({
              status: 'failed',
              branch: 'sloppenheimer/issue-167',
              category: 'publication_failed',
              attempts: 1,
            })
            expect(lookup.detail.handoff.outcome).toBe('delivery_failed')
          }
        }),
      )
    }),
  )

  it.scoped('publishes retained work on a later attempt without running the agent again', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-delivery-retry-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      const harness = makeHarness(isolated, () => [issue])
      let launched = 0
      const publications: string[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          handoffCompletedWork: () =>
            Effect.succeed({
              _tag: 'PullRequest' as const,
              branchName: 'sloppenheimer/issue-167',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/167',
              pullRequestNumber: 167,
              created: true,
            }),
        }),
        makeSourceControl: () =>
          failingSourceControl(
            () => launched > 0,
            (_candidate, prepared) => {
              publications.push(prepared.target.branchName)
              // The first attempt is the one PR #152 hit; the second is the credential or the
              // metadata being usable again, with the same worktree still in place.
              return publications.length === 1
                ? Effect.fail(deliveryFailure({ category: 'authentication_failed' }))
                : Effect.succeed({
                    _tag: 'Published',
                    branchName: prepared.target.branchName,
                    headSha: 'delivered-head',
                    commitCreated: true,
                  })
            },
          ),
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let snapshot = yield* control.snapshot
          while (snapshot.delivering.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          // Past the delivery backoff: what comes due is a publication, not a turn.
          yield* TestClock.adjust('30 seconds')
          while (snapshot.handoffs.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          expect(publications).toEqual(['sloppenheimer/issue-167', 'sloppenheimer/issue-167'])
          expect(launched).toBe(1)
          expect(snapshot.delivering).toEqual([])
          expect(snapshot.handoffs[0]).toMatchObject({
            issueId: issue.id,
            branchName: 'sloppenheimer/issue-167',
            state: 'awaiting_checks',
          })

          const lookup = yield* control.agentDetail(issue.identifier)
          if (lookup._tag === 'Found') {
            expect(lookup.detail.handoff.publication).toMatchObject({
              status: 'published',
              headSha: 'delivered-head',
            })
          }
        }),
      )
    }),
  )

  it.scoped('reports a repair whose delivery failed as delivery_failed, not as no progress', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-delivery-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [issue])
      let launched = 0
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        makeSourceControl: () =>
          failingSourceControl(
            () => launched > 0,
            () => Effect.fail(deliveryFailure()),
          ),
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.delivering.length === 0) {
            yield* Effect.yieldNow()
            yield* control.refresh
            current = yield* control.snapshot
          }
          return current
        }),
      )

      // The pull-request head is exactly where the repair started, which is the observation that
      // used to be reported as an agent that changed nothing. It is not: the change is in the
      // workspace, and what failed is the delivery.
      expect(snapshot.handoffs[0]).toMatchObject({
        issueId: issue.id,
        state: 'delivery_failed',
        headSha: head,
        repairAttempts: 0,
      })
      expect(snapshot.handoffs[0]?.reason).toContain('have not reached the pull request')
      expect(snapshot.handoffs[0]?.reason).not.toContain(
        'completed without changing the pull request head',
      )
      expect(snapshot.delivering[0]).toMatchObject({
        identifier: issue.identifier,
        branchName: 'sloppenheimer/issue-20',
        repairRun: true,
      })
    }),
  )

  it.scoped('does not retire a slow publication as a stalled agent', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-postflight-stall-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      const harness = makeHarness(isolated, () => [issue])
      let launched = 0
      let release = (): void => undefined
      const publishing = new Promise<void>((resolve) => {
        release = resolve
      })
      const publications: string[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          handoffCompletedWork: () =>
            Effect.succeed({
              _tag: 'PullRequest' as const,
              branchName: 'sloppenheimer/issue-167',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/167',
              pullRequestNumber: 167,
              created: true,
            }),
        }),
        makeSourceControl: () =>
          failingSourceControl(
            () => launched > 0,
            (_candidate, prepared) => {
              publications.push(prepared.target.branchName)
              // A push that outlasts the stall timeout. No agent is running and no protocol event
              // can arrive, which is exactly what the stall sweep used to read as a stalled agent.
              return Effect.promise(() => publishing).pipe(
                Effect.as({
                  _tag: 'Published',
                  branchName: prepared.target.branchName,
                  headSha: 'published-head',
                  commitCreated: true,
                }),
              )
            },
          ),
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          while (publications.length === 0) {
            yield* Effect.yieldNow()
          }

          // Well past the stall timeout, with the publication still in flight.
          yield* TestClock.adjust('30 minutes')
          yield* control.refresh
          yield* control.refresh
          const snapshot = yield* control.snapshot

          // A publication that cannot finish is the source control's to fail, and it fails as a
          // delivery. Retiring it here would rerun the coding agent on work it already completed.
          expect(launched).toBe(1)
          expect(snapshot.retrying).toEqual([])
          expect(snapshot.running).toHaveLength(1)

          // And the surfaces say so. Stall detection is off for this run, so publishing a deadline
          // it will never act on is what has the console reporting a stalled agent.
          expect(snapshot.running[0]?.stallDeadline).toBeNull()
          const lookup = yield* control.agentDetail(issue.identifier)
          expect(lookup._tag).toBe('Found')
          if (lookup._tag === 'Found') {
            expect(lookup.detail.phase.phase).toBe('publishing')
            expect(lookup.detail.activity.stalled).toBe(false)
            expect(lookup.detail.activity.stallDeadline).toBeNull()
          }

          release()
          while ((yield* control.snapshot).handoffs.length === 0) {
            yield* Effect.yieldNow()
          }
          expect(launched).toBe(1)
        }),
      )
    }),
  )

  it.scoped('retains a delivery whose discard could not remove the workspace, and retries it', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-discard-retry-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      let reported: Issue = issue
      const harness = makeHarness(isolated, () => [reported])
      let launched = 0
      let removals = 0
      // The second removal is held until the retained state has been looked at: a single clock
      // adjustment runs the whole chain otherwise, and what this asserts is the state in between.
      const release = yield* Deferred.make<void>()
      const ports: TestPorts = {
        ...harness.ports,
        makeWorkspaces: (settings) => ({
          ...harness.ports.makeWorkspaces(settings),
          // The first removal fails: the files are still there, so the discard it would have
          // made true has not happened.
          remove: () =>
            Effect.suspend(() => {
              removals += 1
              return removals === 1
                ? Effect.fail(
                    new WorkspaceError({
                      category: 'remove_failed',
                      message: 'the workspace directory is busy',
                    }),
                  )
                : Deferred.await(release)
            }),
        }),
        makeSourceControl: () =>
          failingSourceControl(
            () => launched > 0,
            () => Effect.fail(deliveryFailure()),
          ),
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let snapshot = yield* control.snapshot
          while (snapshot.delivering.length === 0) {
            yield* Effect.yieldNow()
            yield* control.refresh
            snapshot = yield* control.snapshot
          }

          // Closed, so the delivery due next discards the work — and the first removal fails.
          reported = { ...issue, state: 'closed' }
          while (removals < 2) {
            yield* TestClock.adjust('5 minutes')
            yield* Effect.yieldNow()
          }
          snapshot = yield* control.snapshot

          // Not reported as discarded while the files are on disk. The delivery survived the
          // failed removal, is on the next attempt number, and still holds the claim: no agent has
          // been sent at the issue in the meantime.
          expect(snapshot.delivering).toHaveLength(1)
          expect(snapshot.delivering[0]?.attempt).toBe(2)
          expect(launched).toBe(1)

          yield* Deferred.succeed(release, undefined)
          snapshot = yield* control.snapshot
          while (snapshot.delivering.length > 0) {
            yield* Effect.yieldNow()
            yield* control.refresh
            snapshot = yield* control.snapshot
          }

          // The second removal made the discard true, so the delivery and its claim are gone — and
          // it was the attempt's removal that made it true: the settlement did not remove again.
          expect(launched).toBe(1)
          expect(removals).toBe(2)
        }),
      )
    }),
  )

  it.scoped('keeps the event loop answering while a delivery publication hangs', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-delivery-loop-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      const harness = makeHarness(isolated, () => [issue])
      let launched = 0
      let attempts = 0
      let release = (): void => undefined
      const hanging = new Promise<void>((resolve) => {
        release = resolve
      })
      const ports: TestPorts = {
        ...harness.ports,
        makeSourceControl: () =>
          failingSourceControl(
            () => launched > 0,
            () => {
              attempts += 1
              // The turn's own publication fails, which retains the work; the delivery's retry then
              // never returns — a push waiting on a child process that will not close.
              return attempts === 1
                ? Effect.fail(deliveryFailure())
                : Effect.promise(() => hanging).pipe(
                    Effect.as({
                      _tag: 'Published',
                      branchName: 'sloppenheimer/issue-167',
                      headSha: 'published-head',
                      commitCreated: true,
                    }),
                  )
            },
          ),
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let snapshot = yield* control.snapshot
          while (snapshot.delivering.length === 0) {
            yield* Effect.yieldNow()
            yield* control.refresh
            snapshot = yield* control.snapshot
          }

          while (attempts < 2) {
            yield* TestClock.adjust('5 minutes')
            yield* Effect.yieldNow()
          }

          // The publication is in flight and will not return. Both of these complete only once the
          // loop has run a handler, so neither answers while one hung push holds it.
          yield* control.setIssuePaused(167, true)
          yield* control.refresh

          // And the delivery is still the state's while its attempt runs: an entry taken out for
          // the duration would be an issue with a claim nobody holds and a workspace nobody has
          // examined, with an agent free to be sent into the worktree the push is reading.
          snapshot = yield* control.snapshot
          expect(snapshot.delivering).toHaveLength(1)
          expect(launched).toBe(1)

          release()
        }),
      )
    }),
  )

  it.scoped('records the postflight takeover before the publication makes its first call', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-postflight-takeover-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      const harness = makeHarness(isolated, () => [issue])
      let launched = 0
      // What the run looked like from outside at the moment the postflight first touched git.
      const seen: Readonly<{ marked: boolean; phase: string | null }>[] = []
      let observe: Effect.Effect<void> = Effect.void
      const ports: TestPorts = {
        ...harness.ports,
        makeSourceControl: () => {
          const port = failingSourceControl(
            () => launched > 0,
            () => Effect.fail(deliveryFailure()),
          )
          return {
            ...port,
            inspect: (prepared) =>
              Effect.gen(function* () {
                yield* observe
                return yield* port.inspect(prepared)
              }),
          }
        },
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          // Assigned before anything can suspend this fiber, so the loop the start forked cannot
          // reach a postflight ahead of it.
          observe = Effect.gen(function* () {
            const snapshot = yield* control.snapshot
            // The recovery sweep inspects the same workspace with no run behind it, and a
            // publication nobody is running an agent for has no takeover to record.
            if (snapshot.running.length === 0) {
              return
            }
            const lookup = yield* control.agentDetail(issue.identifier)
            seen.push({
              marked: snapshot.running[0]?.stallDeadline === null,
              phase: lookup._tag === 'Found' ? lookup.detail.phase.phase : null,
            })
          })

          let snapshot = yield* control.snapshot
          while (snapshot.delivering.length === 0) {
            yield* Effect.yieldNow()
            yield* control.refresh
            snapshot = yield* control.snapshot
          }

          // Enqueueing the takeover and publishing anyway would leave a poll already in flight
          // reading a run nothing had marked — and retiring the publication as a stalled agent.
          // So the worker waits for the marker to be in the state, not merely sent.
          expect(seen.length).toBeGreaterThan(0)
          expect(seen).toEqual(seen.map(() => ({ marked: true, phase: 'publishing' })))
        }),
      )
    }),
  )

  it.scoped('keeps the issue claimed while a delivery waits, so no agent joins it', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-delivery-claim-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      // Routable and active, so nothing but the claim stands between it and a second dispatch.
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [issue])
      let launched = 0
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        makeSourceControl: () =>
          failingSourceControl(
            () => launched > 0,
            () => Effect.fail(deliveryFailure()),
          ),
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let snapshot = yield* control.snapshot
          while (snapshot.delivering.length === 0) {
            yield* Effect.yieldNow()
            yield* control.refresh
            snapshot = yield* control.snapshot
          }
          const afterDelivery = launched

          // Reconciliation releases the claim of every handoff nothing is acting on. Work waiting
          // to be published is something acting on it: an agent admitted here would be editing the
          // very worktree the queued publication is about to push.
          yield* control.refresh
          yield* control.refresh
          snapshot = yield* control.snapshot

          expect(launched).toBe(afterDelivery)
          expect(snapshot.delivering).toHaveLength(1)
          expect(snapshot.running).toEqual([])
        }),
      )
    }),
  )

  it.scoped('holds retained work while an operator pause stands, and delivers it on resume', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-delivery-paused-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      const harness = makeHarness(isolated, () => [issue])
      let launched = 0
      const publications: string[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          handoffCompletedWork: () =>
            Effect.succeed({
              _tag: 'PullRequest' as const,
              branchName: 'sloppenheimer/issue-167',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/167',
              pullRequestNumber: 167,
              created: true,
            }),
        }),
        makeSourceControl: () =>
          failingSourceControl(
            () => launched > 0,
            (_candidate, prepared) => {
              publications.push(prepared.target.branchName)
              return publications.length === 1
                ? Effect.fail(deliveryFailure())
                : Effect.succeed({
                    _tag: 'Published',
                    branchName: prepared.target.branchName,
                    headSha: 'delivered-head',
                    commitCreated: true,
                  })
            },
          ),
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let snapshot = yield* control.snapshot
          while (snapshot.delivering.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          yield* control.setIssuePaused(167, true)
          yield* control.refresh
          // Well past the delivery backoff. A pause is a decision to stop, so nothing is pushed —
          // and the work is still there, rather than discarded with the attempt that was waiting.
          yield* TestClock.adjust('5 minutes')
          snapshot = yield* control.snapshot
          expect(publications).toEqual(['sloppenheimer/issue-167'])
          expect(snapshot.delivering).toHaveLength(1)
          expect(snapshot.retrying).toEqual([])

          yield* control.setIssuePaused(167, false)
          yield* control.refresh
          yield* TestClock.adjust('30 seconds')
          while (snapshot.handoffs.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          // Resumed from the attempt it was suspended on, not from a fresh one, and with no agent
          // in between.
          expect(publications).toHaveLength(2)
          expect(launched).toBe(1)
          expect(snapshot.delivering).toEqual([])
        }),
      )
    }),
  )

  it.scoped('holds a publication through pause without creating a pull request', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-delivery-paused-in-flight-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      const harness = makeHarness(isolated, () => [issue])
      let launched = 0
      let publications = 0
      // The retried publication is held until the pause has landed under it.
      const release = yield* Deferred.make<void>()
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          handoffCompletedWork: () =>
            Effect.succeed({
              _tag: 'PullRequest' as const,
              branchName: 'sloppenheimer/issue-167',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/167',
              pullRequestNumber: 167,
              created: true,
            }),
          // Once the pause lifts the handoff is reconciled again; an observation with nothing to
          // act on keeps that pass to the inspection alone.
          inspectPullRequest: (number) =>
            Effect.succeed(
              anOpenPullRequest({
                number,
                headSha: 'delivered-head',
                checks: [{ name: 'quality', status: 'in_progress', conclusion: null, url: null }],
                codexReview: { headSha: 'delivered-head', status: 'pending' },
              }),
            ),
        }),
        makeSourceControl: () =>
          failingSourceControl(
            () => launched > 0,
            (_candidate, prepared) => {
              publications += 1
              // The turn's own publication fails, which retains the work; the delivery's retry is
              // the publication the pause finds under way.
              return publications === 1
                ? Effect.fail(deliveryFailure())
                : Deferred.await(release).pipe(
                    Effect.as({
                      _tag: 'Published' as const,
                      branchName: prepared.target.branchName,
                      headSha: 'delivered-head',
                      commitCreated: true,
                    }),
                  )
            },
          ),
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let snapshot = yield* control.snapshot
          while (snapshot.delivering.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }
          while (publications < 2) {
            yield* TestClock.adjust('30 seconds')
            yield* Effect.yieldNow()
          }

          // The pause lands on a publication under way, which it deliberately leaves to finish.
          yield* control.setIssuePaused(167, true)
          yield* Deferred.succeed(release, undefined)
          yield* control.refresh
          for (let round = 0; round < 3; round += 1) {
            yield* TestClock.adjust('2 seconds')
            yield* control.refresh
          }
          snapshot = yield* control.snapshot
          expect(snapshot.handoffs).toEqual([])
          expect(snapshot.pausedIssueNumbers).toEqual([167])
          expect(launched).toBe(1)
          yield* control.setIssuePaused(167, false)
          yield* control.refresh
          for (
            let round = 0;
            round < 5 && (yield* control.snapshot).handoffs.length === 0;
            round += 1
          ) {
            yield* TestClock.adjust('30 seconds')
            yield* control.refresh
          }
          expect((yield* control.snapshot).handoffs).toHaveLength(1)
        }),
      )
    }),
  )

  it.scoped('publishes a retained delivery through the credential a rotation installed', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-delivery-rotation-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      const environment: Record<string, string> = { SLOPPENHEIMER_TEST_TOKEN: 'secret' }
      const harness = makeHarness(isolated, () => [issue], undefined, environment)
      let launched = 0
      const publications: string[] = []
      const ports: TestPorts = {
        ...harness.ports,
        environment,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          handoffCompletedWork: () =>
            Effect.succeed({
              _tag: 'PullRequest' as const,
              branchName: 'sloppenheimer/issue-167',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/167',
              pullRequestNumber: 167,
              created: true,
            }),
        }),
        makeSourceControl: () =>
          failingSourceControl(
            () => launched > 0,
            (_candidate, prepared) => {
              publications.push(prepared.target.branchName)
              return publications.length === 1
                ? Effect.fail(deliveryFailure({ category: 'authentication_failed' }))
                : Effect.succeed({
                    _tag: 'Published',
                    branchName: prepared.target.branchName,
                    headSha: 'delivered-head',
                    commitCreated: true,
                  })
            },
          ),
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let snapshot = yield* control.snapshot
          while (snapshot.delivering.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          // The retained work outlives the credential it was produced under, and a rotation is
          // exactly what makes the next attempt worth having.
          environment['SLOPPENHEIMER_TEST_TOKEN'] = 'rotated'
          yield* control.refresh
          yield* TestClock.adjust('30 seconds')
          while (publications.length < 2) {
            yield* Effect.yieldNow()
          }
        }),
      )

      // The delivery re-read its issue through the tracker the rotation installed, not the
      // instance the orchestrator had already retired.
      expect(harness.idFetchTokens().at(-1)).toBe('rotated')
      expect(launched).toBe(1)
    }),
  )

  it.scoped('hands the work back to the agent once the delivery attempts are spent', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-delivery-spent-')
      const isolated: Workflow = {
        ...workflow,
        config: {
          ...workflow.config,
          // Keep each observed delivery deadline close without changing the attempt budget.
          agent: { ...workflow.config.agent, maxRetryBackoffMs: 10_000 },
        },
      }
      const rooted: Workflow = { ...isolated, config: { ...isolated.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      const harness = makeHarness(rooted, () => [issue])
      const replacementStarted = yield* Deferred.make<void>()
      let launched = 0
      const publications: string[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeSourceControl: () =>
          failingSourceControl(
            () => launched > 0,
            (_candidate, prepared) => {
              publications.push(prepared.target.branchName)
              return Effect.fail(deliveryFailure())
            },
          ),
        runAgent: () =>
          Effect.gen(function* () {
            launched += 1
            if (launched > 1) {
              yield* Deferred.succeed(replacementStarted, undefined)
              return yield* Effect.never
            }
            return { threadId: 'thread', turnId: 'turn', turnCount: 1 }
          }),
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let snapshot = yield* control.snapshot
          for (let attempt = 1; attempt < deliveryAttemptLimit; attempt += 1) {
            // Real workspace I/O may still be settling the previous result. Do not advance time
            // until its next delivery is recorded, or the clock can also fire the agent retry.
            while (snapshot.delivering[0]?.attempt !== attempt) {
              yield* Effect.yieldNow()
              snapshot = yield* control.snapshot
            }
            const delivery = snapshot.delivering[0]
            if (delivery === undefined) {
              return yield* Effect.die('the observed delivery must exist')
            }
            yield* TestClock.setTime(new Date(delivery.dueAt).getTime())
            snapshot = yield* control.snapshot
          }
          // Let the final result settle without firing the replacement agent's timer.
          while (snapshot.retrying.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          // Five publications in total, the turn's own included, and then the work goes back to
          // the coding agent rather than being retried forever or dropped.
          expect(publications).toHaveLength(deliveryAttemptLimit)
          expect(snapshot.delivering).toEqual([])
          expect(snapshot.retrying[0]?.error).toContain('delivery failed')
          expect(launched).toBe(1)
          const retry = snapshot.retrying[0]
          if (retry === undefined) {
            return yield* Effect.die('spent delivery must schedule an agent retry')
          }
          yield* TestClock.setTime(new Date(retry.dueAt).getTime())
          yield* Deferred.await(replacementStarted)
          expect(launched).toBe(2)
          expect(publications).toHaveLength(deliveryAttemptLimit)
        }),
      )
    }),
  )

  it.scoped('keeps the workspace manager a reload replaced until its delivery settles', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-delivery-reload-')
      const reloadedRoot = yield* isolatedWorkspaceRoot('sloppenheimer-delivery-reloaded-')
      const initial: Workflow = {
        ...changedWorkflow({ fingerprint: 'initial' }),
        config: { ...workflow.config, workspaceRoot },
      }
      const reloaded: Workflow = {
        ...changedWorkflow({ fingerprint: 'reloaded' }),
        config: { ...initial.config, workspaceRoot: reloadedRoot },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      let reported = issue
      const harness = makeHarness(initial, () => [reported])
      let launched = 0
      const ports: TestPorts = {
        ...harness.ports,
        makeSourceControl: () =>
          failingSourceControl(
            () => launched > 0,
            () => Effect.fail(deliveryFailure()),
          ),
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let snapshot = yield* control.snapshot
          while (snapshot.delivering.length === 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          const beforeReload = harness.releasedWorkspaces().length
          harness.setWorkflow(reloaded)
          harness.notifyChanged()
          while (snapshot.effectiveWorkflow.fingerprint !== 'reloaded') {
            yield* control.refresh
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }
          yield* control.refresh
          yield* control.refresh

          // The retained change is in a workspace this manager opened, and the delivery will reach
          // for it again — to publish it, or to remove it. Releasing the manager with the reload
          // would close the scope around the only copy of that work.
          expect(harness.releasedWorkspaces()).toHaveLength(beforeReload)

          // Closed, so the delivery discards the work with the workspace holding it — the one
          // disposition that calls through the manager it has been carrying all along.
          reported = { ...issue, state: 'closed' }
          yield* TestClock.adjust('5 minutes')
          while (snapshot.delivering.length > 0) {
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }
          yield* control.refresh
          yield* control.refresh

          expect(harness.releasedWorkspaces().length).toBeGreaterThan(beforeReload)
        }),
      )
    }),
  )
})

describe('restored pull request handoffs', (): void => {
  it.scoped(
    'rediscovers open pull requests for active issue branches when the store is missing',
    () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-recovered-handoff-')
        const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
        const issue = {
          ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
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
                branchName: `sloppenheimer/issue-${candidate.id}`,
                pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
                pullRequestNumber: 65,
                created: false,
              }),
            inspectPullRequest: (number) =>
              Effect.succeed({
                number,
                url: 'https://github.test/example/sloppenheimer/pull/65',
                headSha: 'recovered-head',
                merged: false as const,
                state: 'open' as const,
                mergeCommitSha: null,
                mergeable: null,
                mergeState: 'unknown',
                checks: [],
                reviewDecision: null,
                reviewThreads: [],
                codexReview: { headSha: 'recovered-head', status: 'pending' as const },
              }),
          }),
        }

        const snapshot = yield* Effect.scoped(
          Effect.gen(function* () {
            const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
            yield* control.refresh
            return yield* control.snapshot
          }),
        )

        expect(snapshot.handoffs).toHaveLength(1)
        expect(snapshot.handoffs[0]).toMatchObject({
          issueId: issue.id,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
          branchName: 'sloppenheimer/issue-20',
          headSha: 'recovered-head',
          state: 'awaiting_checks',
        })
        expect(snapshot.handoffRecovery).toMatchObject({
          status: 'completed',
          loaded: 0,
          recovered: 1,
          failed: 0,
        })
        expect(
          yield* loadHandoffs(join(workspaceRoot, '.sloppenheimer', 'handoffs.json')),
        ).toHaveLength(1)
      }),
  )

  it.scoped('skips non-dispatchable pull request records during recovery', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-nondispatchable-handoff-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const pullRequestRecord = {
        ...makeIssue('example/sloppenheimer#117', 1, null, ['sloppenheimer', 'ready']),
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
              return { _tag: 'NoBranch' as const, branchName: 'sloppenheimer/issue-117' }
            }),
        }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      expect(discoveries).toBe(0)
      expect(harness.agentRuns()).toEqual([])
      expect(snapshot.handoffs).toEqual([])
      expect(snapshot.handoffRecovery).toMatchObject({ recovered: 0, skipped: 1 })
    }),
  )

  it.scoped('supplements a partial store without duplicating its persisted handoff', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-partial-handoff-')
      const storePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const first = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const second = {
        ...makeIssue('example/sloppenheimer#75', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('75'),
      }
      yield* saveHandoffs(storePath, [
        {
          issueId: first.id,
          identifier: first.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
          branchName: 'sloppenheimer/issue-20',
          state: 'awaiting_checks',
          headSha: 'first-head',
          reason: null,
          repairAttempts: 0,
          observedAt: new Date(0).toISOString(),
        },
      ])
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
                branchName: 'sloppenheimer/issue-75',
                pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/95',
                pullRequestNumber: 95,
                created: false,
              }
            }),
          inspectPullRequest: (number) =>
            Effect.succeed({
              number,
              url: `https://github.test/example/sloppenheimer/pull/${String(number)}`,
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
                headSha: number === 65 ? 'first-head' : 'second-head',
                status: 'pending' as const,
              },
            }),
        }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      expect(discoveries).toBe(1)
      expect(snapshot.handoffs.map((handoff) => handoff.issueId).sort()).toEqual(['20', '75'])
      expect(snapshot.handoffRecovery).toMatchObject({ loaded: 1, recovered: 1 })
      expect(yield* loadHandoffs(storePath)).toHaveLength(2)
    }),
  )

  it.scoped('reports a malformed store and does not replace it during recovery', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-malformed-handoff-')
      const storePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      yield* Effect.promise(() => mkdir(join(workspaceRoot, '.sloppenheimer')))
      yield* Effect.promise(() => writeFile(storePath, '{malformed'))
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const harness = makeHarness(isolated)

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      expect(snapshot.handoffRecovery.status).toBe('degraded')
      expect(snapshot.handoffRecovery.storeError).toMatchObject({ operation: 'read' })
      expect(snapshot.handoffRecovery.storeError?.message).toContain(
        `Could not decode handoff store ${storePath}`,
      )
      expect(yield* Effect.promise(() => readFile(storePath, 'utf8'))).toBe('{malformed')
    }),
  )

  it.scoped('retains persisted entries through a transient GitHub hydration failure', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-transient-handoff-')
      const storePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#75', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('75'),
      }
      yield* saveHandoffs(storePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/95',
          branchName: 'sloppenheimer/issue-75',
          state: 'awaiting_checks',
          headSha: 'persisted-head',
          reason: null,
          repairAttempts: 0,
          observedAt: new Date(0).toISOString(),
        },
      ])
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
              url: 'https://github.test/example/sloppenheimer/pull/95',
              headSha: 'persisted-head',
              merged: false as const,
              state: 'open' as const,
              mergeCommitSha: null,
              mergeable: null,
              mergeState: 'unknown',
              checks: [],
              reviewDecision: null,
              reviewThreads: [],
              codexReview: { headSha: 'persisted-head', status: 'pending' as const },
            }),
        }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      expect(hydrationAttempts).toBeGreaterThanOrEqual(2)
      expect(snapshot.handoffs).toHaveLength(1)
      expect(snapshot.handoffRecovery).toMatchObject({ loaded: 1, recovered: 0 })
      expect(yield* loadHandoffs(storePath)).toHaveLength(1)
    }),
  )

  it.scoped('removes a restored handoff after its pull request is confirmed merged', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-restored-handoff-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = {
        ...workflow,
        config: { ...workflow.config, workspaceRoot },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#63', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('63'),
      }
      yield* saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/44',
          branchName: 'sloppenheimer/issue-63',
          state: 'awaiting_checks',
          headSha: null,
          reason: 'GitHub pull request status is incomplete',
          repairAttempts: 0,
          observedAt: new Date(0).toISOString(),
        },
      ])
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

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
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
        pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/44',
        // The provider's merge time, not the instant this host noticed it. Dating it now would put
        // work merged days ago back into the console's recent-activity window.
        finishedAt: '2026-08-20T09:00:00.000Z',
      })
      expect(yield* loadHandoffs(handoffStorePath)).toEqual([])
    }),
  )

  it.scoped('releases a restored closed handoff claim and dispatches by current routability', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-closed-handoff-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = {
        ...workflow,
        config: { ...workflow.config, workspaceRoot },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#75', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('75'),
      }
      yield* saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/50',
          branchName: 'sloppenheimer/issue-75',
          state: 'awaiting_checks',
          headSha: 'closed-head',
          reason: null,
          repairAttempts: 0,
          observedAt: new Date(0).toISOString(),
        },
      ])
      const harness = makeHarness(isolated, () => [issue])
      let inspections = 0
      let issueRefreshes = 0
      let refreshesAfterClose = 0
      const ports: TestPorts = {
        ...harness.ports,
        makeTracker: (provider) => {
          const tracker = harness.ports.makeTracker(provider)
          return {
            ...tracker,
            fetchIssuesByIds: (ids, options) => {
              issueRefreshes += 1
              return tracker.fetchIssuesByIds(ids, options)
            },
          }
        },
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (pullRequestNumber) =>
            Effect.sync(() => {
              inspections += 1
              return {
                number: pullRequestNumber,
                state: 'closed' as const,
                url: 'https://github.test/example/sloppenheimer/pull/50',
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

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          refreshesAfterClose = issueRefreshes
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      expect(inspections).toBe(1)
      expect(refreshesAfterClose).toBeGreaterThan(0)
      expect(issueRefreshes).toBeGreaterThanOrEqual(refreshesAfterClose)
      expect(snapshot.running).toEqual([
        expect.objectContaining({ issueId: issue.id, identifier: issue.identifier }),
      ])
      expect(snapshot.inspectableAgents).toContain(issue.identifier)
      expect(snapshot.handoffs).toEqual([
        expect.objectContaining({
          issueId: '75',
          state: 'closed_without_merge',
          reason: 'The pull request was closed without being merged',
          repairAttempts: 0,
        }),
      ])
      expect(yield* loadHandoffs(handoffStorePath)).toEqual([
        expect.objectContaining({ state: 'closed_without_merge' }),
      ])
    }),
  )

  it.scoped('isolates eligibility refresh failures between repair handoffs', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-isolated-handoff-refresh-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const failedIssue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const healthyIssue = {
        ...makeIssue('example/sloppenheimer#21', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('21'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveHandoffs(
        handoffStorePath,
        [failedIssue, healthyIssue].map((issue, index) => ({
          issueId: issue.id,
    …50509 tokens truncated…t(harness.releasedTrackers()).toHaveLength(1)

          finishWorker()
          // Waited for rather than counted in refreshes: what is under test is that the release
          // happens once the run ends, not how many passes that takes.
          while (harness.releasedTrackers().length < 2) {
            yield* Effect.yieldNow()
            yield* control.refresh
          }
          const snapshot = yield* control.snapshot

          // The run has ended into a handoff under the same issue, and that handoff holds the
          // adopted tracker — so what the run superseded is free while the pull request stays open.
          expect(snapshot.handoffs).toHaveLength(1)
          expect(
            harness.releasedTrackers().map((each) => Redacted.value(githubProviderOf(each).token)),
          ).toEqual(['secret', 'secret'])
          return snapshot
        }),
      )

      expect(snapshot.handoffs[0]).toMatchObject({ state: 'awaiting_checks' })
    }),
  )

  it.effect('keeps the workspace manager a reload replaced until the worker holding it ends', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#1', 1, null, ['sloppenheimer', 'ready'])
      const initial = changedWorkflow({ fingerprint: 'initial' })
      const reloaded: Workflow = {
        ...changedWorkflow({ fingerprint: 'reloaded' }),
        config: { ...initial.config, workspaceRoot: '/tmp/sloppenheimer-reloaded' },
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* Effect.promise(() => started)
          harness.setWorkflow(reloaded)
          yield* control.refresh

          expect(harness.workspaceSettings().map((each) => each.root)).toEqual([
            '/tmp/sloppenheimer',
            '/tmp/sloppenheimer',
            '/tmp/sloppenheimer-reloaded',
          ])
          // One release, not two: the instance the layer built was replaced at startup and freed on
          // the first poll, while the one the running worker holds outlives the reload.
          expect(harness.releasedWorkspaces()).toHaveLength(1)

          finishWorker()
          while ((yield* control.snapshot).running.length !== 0) {
            yield* Effect.yieldNow()
          }
          yield* control.refresh
          yield* control.refresh

          expect(harness.releasedWorkspaces()).toHaveLength(2)
        }),
      )
    }),
  )
})

describe('scheduler dependency hydration', (): void => {
  it.effect('requests hydration for every candidate when no labels are required', () =>
    Effect.gen(function* () {
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
        }),
      )

      expect(requested).toContain(null)
      expect(requested).not.toContainEqual([])
    }),
  )

  it.effect('passes the configured labels through when some are required', () =>
    Effect.gen(function* () {
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
        }),
      )

      expect(requested).toContainEqual(['sloppenheimer', 'ready'])
    }),
  )
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
              // Telemetry only: this helper drives usage and rate-limit accounting, not the
              // session lifecycle, which the tests that need it state explicitly.
              lifecycle: null,
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

/**
 * The one runner left in this suite, and deliberately so: `agentDetail` reads a `Ref` and the
 * clock and nothing else, and every caller here is a synchronous predicate handed to `waitUntil`,
 * which polls the host in real time because the worker it waits on runs on the host rather than
 * on the test clock. Making it an effect would mean an effectful predicate the polling loop
 * cannot take.
 */
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
  it.effect('publishes an ordered, redacted, bounded timeline for a running agent', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#7', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(workflow, () => [issue])
      const factory = makeAgentFactory()

      const observed = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          const agent = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/sloppenheimer#7'),
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
              'example/sloppenheimer#7',
              (candidate) => candidate.timeline.events.length >= 5,
              'five retained events',
            ),
          )
          const snapshot = yield* control.snapshot
          return { detail, snapshot }
        }),
      )

      const detail = observed.detail
      expect(detail.status).toBe('running')
      expect(detail.self).toBe('/api/v1/agents/example%2Fsloppenheimer%237')
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
    }),
  )

  it.effect('separates attempts across a retry while keeping one rising sequence', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#8', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(workflow, () => [issue])
      const factory = makeAgentFactory()

      const detail = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          const first = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/sloppenheimer#8'),
          )
          first.notify('item/completed', { item: { type: 'reasoning' } })
          yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/sloppenheimer#8',
              (candidate) => candidate.timeline.events.length === 1,
              'the first attempt event',
            ),
          )
          factory.agents.delete('example/sloppenheimer#8')
          first.settle('failed')
          const retrying = yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/sloppenheimer#8',
              (candidate) => candidate.status === 'retrying',
              'the scheduled retry',
            ),
          )
          expect(retrying.retry?.attempt).toBe(1)
          expect(retrying.phase.phase).toBe('retrying')
          yield* TestClock.adjust('20 seconds')
          const second = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/sloppenheimer#8'),
          )
          second.notify('item/completed', {
            item: { type: 'commandExecution', command: 'pnpm test', status: 'completed' },
          })
          return yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/sloppenheimer#8',
              (candidate) =>
                candidate.attempt.current === 1 &&
                candidate.status === 'running' &&
                candidate.timeline.events.length === 4,
              'the second attempt',
            ),
          )
        }),
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
    }),
  )

  it.effect('keeps concurrent agents in separate records', () =>
    Effect.gen(function* () {
      const issues = [
        makeIssue('example/sloppenheimer#11', 1, null, ['sloppenheimer', 'ready']),
        makeIssue('example/sloppenheimer#12', 1, null, ['sloppenheimer', 'ready']),
      ]
      const harness = makeHarness(
        changedWorkflow({ fingerprint: 'test', maxConcurrentAgents: 2 }),
        () => issues,
      )
      const factory = makeAgentFactory()

      const details = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          const first = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/sloppenheimer#11'),
          )
          const second = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/sloppenheimer#12'),
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
              'example/sloppenheimer#11',
              (candidate) => candidate.timeline.events.length === 1,
              'the first record',
            ),
          )
          const right = yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/sloppenheimer#12',
              (candidate) => candidate.timeline.events.length === 2,
              'the second record',
            ),
          )
          return { left, right }
        }),
      )

      expect(details.left.timeline.events.map((event) => event.category)).toEqual(['reasoning'])
      expect(details.right.timeline.events.map((event) => event.category)).toEqual([
        'command',
        'file',
      ])
      expect(details.left.workspace.dirtyFileCount).toBe(0)
      expect(details.right.workspace.dirtyFileCount).toBe(1)
    }),
  )

  it.scoped('records handoff progress and keeps the completed record readable', () =>
    Effect.gen(function* () {
      // A handoff is persisted, so this run gets a workspace root of its own.
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-handoff-detail-')
      const isolated: Workflow = {
        ...workflow,
        config: { ...workflow.config, workspaceRoot },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#13', 1, null, ['sloppenheimer', 'ready']),
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
              branchName: 'sloppenheimer/issue-13',
              pullRequestUrl: 'https://example.test/pull/61',
              pullRequestNumber: 61,
              created: true,
            }),
        }),
      }

      const detail = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          const agent = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/sloppenheimer#13'),
          )
          agent.settle('completed')
          return yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/sloppenheimer#13',
              // The worker leaves `running` before the tracker is asked. Wait for both the
              // completed handoff and its mandatory continuation retry publication.
              (candidate) =>
                candidate.status === 'retrying' && candidate.handoff.outcome !== 'in_progress',
              'the completed handoff',
            ),
          )
        }),
      )

      expect(detail.status).toBe('retrying')
      expect(detail.handoff).toMatchObject({
        expectedBranch: 'sloppenheimer/issue-13',
        remoteBranch: { status: 'observed', name: 'sloppenheimer/issue-13' },
        pullRequest: {
          status: 'created',
          number: 61,
          url: 'https://example.test/pull/61',
          state: 'awaiting_checks',
        },
        dispatchLabels: { labels: ['sloppenheimer', 'ready'], status: 'not_performed' },
        outcome: 'pull_request_open',
      })
      // The host's own publication is recorded before anything asks about a pull request: the
      // work reached the remote, and only then is there a branch to hand off.
      expect(detail.handoff.publication).toMatchObject({
        status: 'published',
        branch: 'sloppenheimer/issue-13',
        headSha: 'published-head',
      })
      // The publication and the four handoff steps are followed by the mandatory continuation retry.
      expect(detail.timeline.events.map((event) => event.category)).toEqual([
        'handoff',
        'handoff',
        'handoff',
        'handoff',
        'handoff',
        'retry',
      ])
      expect(
        detail.timeline.events.map((event) => event.category === 'handoff' && event.status),
      ).toEqual(['observed', 'pending', 'observed', 'observed', 'not_performed', false])
      expect(detail.activity.stallDeadline).toBeNull()
    }),
  )

  it.scoped('publishes the handoff transition before waiting on the tracker', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-handoff-timing-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#19', 1, null, ['sloppenheimer', 'ready']),
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
              : Effect.succeed({ _tag: 'NoBranch', branchName: 'sloppenheimer/issue-19' }),
        }),
      }

      const detail = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          const agent = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/sloppenheimer#19'),
          )
          agent.settle('completed')
          yield* Effect.promise(() => handoffReached)
          // The worker has left the running map and the tracker has not answered yet: the
          // published detail must already say so rather than still counting down to stalled.
          return yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/sloppenheimer#19',
              (candidate) => candidate.phase.phase === 'handing_off',
              'the handoff transition',
            ),
          )
        }),
      )

      expect(detail.status).toBe('completed')
      expect(detail.activity.stallDeadline).toBeNull()
      expect(detail.timeline.events.at(-1)).toMatchObject({
        category: 'handoff',
        status: 'pending',
      })
      blockHandoff = false
    }),
  )

  it.effect('applies an agent update reported in the same turn the worker settles', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#21', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(workflow, () => [issue])
      const factory = makeAgentFactory()

      const detail = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          const agent = yield* Effect.promise(() =>
            awaitAgent(factory.agents, 'example/sloppenheimer#21'),
          )
          // The offer the runner's callback makes has to be in the mailbox by the time the callback
          // returns. If it were only scheduled, the worker's own exit could overtake it and the
          // event loop would drop the update as belonging to a run that has already ended.
          agent.notify('item/completed', { item: { type: 'reasoning' } })
          agent.settle('completed')
          return yield* Effect.promise(() =>
            awaitDetail(
              control,
              'example/sloppenheimer#21',
              (candidate) => candidate.status !== 'running',
              'the settled record',
            ),
          )
        }),
      )

      // First in the timeline, ahead of everything the worker's exit records: the update was applied
      // to the live run rather than dropped after it ended.
      expect(detail.timeline.events[0]).toMatchObject({ category: 'reasoning', sequence: 1 })
    }),
  )

  it.effect('answers unknown, sessionless, and starting identifiers distinctly', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#14', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(workflow, () => [issue])
      const factory = makeAgentFactory()

      const lookups = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          yield* Effect.promise(() => awaitAgent(factory.agents, 'example/sloppenheimer#14'))
          yield* Effect.promise(() =>
            awaitDetail(control, 'example/sloppenheimer#14', () => true, 'the running agent'),
          )
          return {
            unknown: readDetail(control, 'example/sloppenheimer#404'),
            running: readDetail(control, 'example/sloppenheimer#14'),
          }
        }),
      )

      expect(lookups.unknown._tag).toBe('Unknown')
      expect(lookups.running._tag).toBe('Found')
    }),
  )

  it.effect('keeps a retry scheduled before the session starts inspectable', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#16', 1, null, ['sloppenheimer', 'ready'])
      // Prompt rendering fails after the tick-wide validation gate admits the candidate, so the
      // retry is scheduled before any agent session exists — and its published link still has to
      // resolve.
      const invalidPrompt = changedWorkflow({
        fingerprint: 'invalid-prompt',
        promptTemplate: '{{ missing }}',
      })
      const harness = makeHarness(invalidPrompt, () => [issue])
      const factory = makeAgentFactory()

      const lookup = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          return yield* Effect.promise(() =>
            waitUntil(() => {
              const found = readDetail(control, 'example/sloppenheimer#16')
              return found._tag === 'Found' && found.detail.status === 'retrying' ? found : null
            }, 'the pre-launch retry to be inspectable'),
          )
        }),
      )

      expect(lookup._tag).toBe('Found')
      if (lookup._tag === 'Found') {
        expect(lookup.detail.retry?.attempt).toBe(1)
        expect(lookup.detail.retry?.reason).toContain('failed to render workflow prompt')
        expect(lookup.detail.timeline.events.map((entry) => entry.category)).toEqual(['retry'])
        expect(factory.agents.size).toBe(0)
      }
    }),
  )

  it.effect('closes the detail of a queued retry an operator pauses away', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#17', 1, null, ['sloppenheimer', 'ready'])
      // The same prompt-rendering failure as above, so the issue is waiting to retry with no session
      // behind it when the pause drops the queued retry.
      const invalidPrompt = changedWorkflow({
        fingerprint: 'invalid-prompt',
        promptTemplate: '{{ missing }}',
      })
      const harness = makeHarness(invalidPrompt, () => [issue])
      const factory = makeAgentFactory()

      const lookup = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            runAgent: factory.runAgent,
          })
          yield* Effect.promise(() =>
            waitUntil(() => {
              const found = readDetail(control, 'example/sloppenheimer#17')
              return found._tag === 'Found' && found.detail.status === 'retrying' ? found : null
            }, 'the pre-launch retry to be inspectable'),
          )

          yield* control.setIssuePaused(17, true)

          yield* control.refresh

          return readDetail(control, 'example/sloppenheimer#17')
        }),
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
    }),
  )

  it.effect(
    'serves detail while a tracker poll is blocked, and hands out immutable snapshots',
    () =>
      Effect.gen(function* () {
        const issue = makeIssue('example/sloppenheimer#15', 1, null, ['sloppenheimer', 'ready'])
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

        const observed = yield* Effect.scoped(
          Effect.gen(function* () {
            const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
              ...harness.ports,
              runAgent: factory.runAgent,
            })
            const agent = yield* Effect.promise(() =>
              awaitAgent(factory.agents, 'example/sloppenheimer#15'),
            )
            agent.notify('item/completed', { item: { type: 'reasoning' } })
            const before = yield* Effect.promise(() =>
              awaitDetail(
                control,
                'example/sloppenheimer#15',
                (candidate) => candidate.timeline.events.length === 1,
                'the first event',
              ),
            )
            // The scheduler is now parked inside a poll. A detail read must still answer, and must
            // not be able to change anything the scheduler owns.
            blockPolling = true
            yield* Effect.forkScoped(control.refresh)
            yield* Effect.promise(settle)
            const during = readDetail(control, 'example/sloppenheimer#15')
            expect(during._tag).toBe('Found')
            const events = before.timeline.events as unknown as { push: (value: unknown) => number }
            expect(() => events.push('tampered')).toThrow()
            const after = readDetail(control, 'example/sloppenheimer#15')
            return { during, after }
          }),
        )

        expect(observed.after._tag).toBe('Found')
        if (observed.after._tag === 'Found') {
          expect(observed.after.detail.timeline.events).toHaveLength(1)
          expect(observed.after.detail.activity.elapsedMs).toBeGreaterThanOrEqual(0)
        }
      }),
  )
})

describe('aged-out agent detail', (): void => {
  it.scoped(
    'retains active review details beyond the completed detail limit',
    () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-aged-out-')
        const total = retainedCompletedDetails + 1
        const issues = Array.from({ length: total }, (_unused, index) => ({
          ...makeIssue(`example/sloppenheimer#${String(index + 20)}`, 1, null, [
            'sloppenheimer',
            'ready',
          ]),
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
        let active = true
        const harness = makeHarness(isolated, () => (active ? issues : []))
        const factory = makeAgentFactory()
        const ports: TestPorts = {
          ...harness.ports,
          runAgent: factory.runAgent,
          makeCodeReview: (provider) => ({
            ...requireCodeReview(harness.ports, provider),
            handoffCompletedWork: (issue) =>
              Effect.succeed({
                _tag: 'PullRequest',
                branchName: `sloppenheimer/issue-${issue.id}`,
                pullRequestUrl: `https://example.test/pull/${issue.id}`,
                pullRequestNumber: Number(issue.id),
                created: true,
              }),
            inspectPullRequest: (number) =>
              Effect.succeed({
                number,
                url: `https://example.test/pull/${String(number)}`,
                headSha: `head-${String(number)}`,
                merged: false,
                state: 'open',
                mergeCommitSha: null,
                mergeable: null,
                mergeState: 'unknown',
                checks: [],
                reviewDecision: null,
                reviewThreads: [],
                codexReview: { headSha: `head-${String(number)}`, status: 'pending' },
              }),
          }),
        }

        const observed = yield* Effect.scoped(
          Effect.gen(function* () {
            const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
            for (const issue of issues) {
              const agent = yield* Effect.promise(() =>
                awaitAgent(factory.agents, issue.identifier),
              )
              agent.settle('completed')
            }
            let pending = yield* control.snapshot
            while (pending.retrying.length !== total) {
              yield* Effect.yieldNow()
              pending = yield* control.snapshot
            }
            active = false
            yield* TestClock.adjust('1 second')
            yield* Effect.yieldNow()
            yield* control.refresh
            expect(
              issues.every((issue) => readDetail(control, issue.identifier)._tag === 'Found'),
            ).toBe(true)
            yield* control.setIssuePaused(9_999, true)
            return issues.every((issue) => readDetail(control, issue.identifier)._tag === 'Found')
          }),
        )

        expect(observed).toBe(true)
      }),
    // This one drives `retainedCompletedDetails + 1` agents, each through a real temporary
    // workspace, and needs six to eight seconds on an unloaded machine. The 5s default left
    // no margin: it passes on a fast runner and times out on a slow one.
    30_000,
  )
})

const makeAgentEvent = (overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  lifecycle: null,
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
  it.effect(
    'tracks metadata and rate limits without double-counting repeated absolute totals',
    () =>
      Effect.gen(function* () {
        const issue = makeIssue('example/sloppenheimer#16', 1, null, ['sloppenheimer', 'ready'])
        const harness = makeHarness(workflow, () => [issue])

        yield* Effect.scoped(
          Effect.gen(function* () {
            const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
            yield* harness.awaitAgentRun
            harness.emitAgentEvent(
              makeAgentEvent({
                event: auroraEvents.bootstrap,
                usage: null,
                lifecycle: { phase: 'session_started' },
              }),
            )
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
              makeAgentEvent({
                event: 'item/completed',
                message: 'meaningful update',
                usage: null,
              }),
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
                event: auroraEvents.legOpened,
                turnId: 'turn-2',
                turnCount: 2,
                message: null,
                usage: null,
                lifecycle: { phase: 'turn_started' },
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
                event: auroraEvents.legSealed,
                turnId: 'turn-2',
                turnCount: 2,
                message: null,
                // The status is retained as operator detail; nothing reads it to decide the outcome.
                turnStatus: 'timed_out',
                usage: null,
                lifecycle: { phase: 'turn_settled', outcome: 'failed' },
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

            yield* control.refresh
            const cancelled = yield* control.snapshot
            expect(cancelled.running).toEqual([])
            expect(cancelled.totals).toMatchObject({
              inputTokens: 14,
              outputTokens: 7,
              totalTokens: 21,
            })
          }),
        )
      }),
  )

  it.effect('cancels a stalled worker and schedules its first retry', () =>
    Effect.gen(function* () {
      const stalledWorkflow: Workflow = {
        ...workflow,
        config: {
          ...workflow.config,
          runner: { ...workflow.config.runner, stallTimeoutMs: 1 },
        },
      }
      const issue = makeIssue('example/sloppenheimer#19', 1, null, ['sloppenheimer', 'ready'])
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* Effect.promise(() => started)
          yield* Effect.yieldNow()
          yield* Effect.yieldNow()

          // The last event is dated at the clock's origin, so the stall bound is passed by moving
          // the clock rather than by however long the test itself took.
          yield* TestClock.adjust(2)
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
      )
    }),
  )

  it.effect('does not launch the agent when beforeRun fails', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#24', 1, null, ['sloppenheimer', 'ready'])
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

      yield* Effect.scoped(
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
      )
    }),
  )

  it.effect('schedules continuation attempt one after a normal exit without a branch', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#23', 1, null, ['sloppenheimer', 'ready'])
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
              return { _tag: 'NoBranch' as const, branchName: 'sloppenheimer/test' }
            }),
        }),
        runAgent: () =>
          Effect.succeed({ threadId: 'thread-normal', turnId: 'turn-normal', turnCount: 1 }),
      }

      yield* Effect.scoped(
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
      )
    }),
  )

  it.scoped('reconciles a pull request before starting its continuation', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-branch-continuation-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#24', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('24'),
      }
      const harness = makeHarness(isolated, () => [issue])
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      let inspections = 0
      let runs = 0
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          handoffCompletedWork: () =>
            Effect.succeed({
              _tag: 'PullRequest' as const,
              branchName: 'sloppenheimer/issue-24',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/24',
              pullRequestNumber: 24,
              created: true,
            }),
          inspectPullRequest: (number) =>
            Effect.sync(() => {
              inspections += 1
              return {
                ...repairObservation(number, head),
                mergeable: null,
                mergeState: 'unknown',
                codexReview: { headSha: head, status: 'pending' as const },
              }
            }),
        }),
        runAgent: () =>
          Effect.suspend(() => {
            runs += 1
            return runs === 1
              ? Effect.succeed({ threadId: 'thread-normal', turnId: 'turn-normal', turnCount: 1 })
              : Effect.never
          }),
      }

      const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
      let current = yield* control.snapshot
      while (current.retrying.length === 0) {
        yield* Effect.yieldNow()
        current = yield* control.snapshot
      }
      const scheduled = current
      yield* TestClock.adjust('1 second')
      while (current.running.length === 0) {
        yield* Effect.yieldNow()
        current = yield* control.snapshot
      }

      expect(scheduled.handoffs).toEqual([
        expect.objectContaining({
          issueId: issue.id,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/24',
          state: 'awaiting_checks',
        }),
      ])
      expect(scheduled.retrying).toEqual([
        expect.objectContaining({ issueId: issue.id, attempt: 1, error: null }),
      ])
      expect(inspections).toBe(1)
      expect(runs).toBe(2)
      expect(current.running).toEqual([expect.objectContaining({ issueId: issue.id, attempt: 1 })])
    }),
  )

  it.effect(
    'uses continuation turns when the tracker has no CodeReviewPort and handoff is disabled',
    () =>
      Effect.gen(function* () {
        const issue = makeIssue('example/sloppenheimer#139', 1, null, ['sloppenheimer', 'ready'])
        const secondKindWorkflow: Workflow = { ...workflow, tracker: stubProvider('secret') }
        const harness = makeHarness(secondKindWorkflow, () => [issue])
        const { makeCodeReview: omittedCodeReview, ...trackerOnlyPorts } = harness.ports
        void omittedCodeReview
        const ports: TestPorts = {
          ...trackerOnlyPorts,
          runAgent: () =>
            Effect.succeed({ threadId: 'thread-neutral', turnId: 'turn-neutral', turnCount: 1 }),
        }

        yield* Effect.scoped(
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
        )
      }),
  )

  it.scoped('preserves the persisted handoff store while handoff is disabled', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-disabled-handoff-')
      const storePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const persisted = {
        issueId: issueId('75'),
        identifier: issueIdentifier('example/sloppenheimer#75'),
        pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/95',
        branchName: 'sloppenheimer/issue-75',
        state: 'awaiting_checks' as const,
        headSha: 'persisted-head',
        reason: null,
        repairAttempts: 0,
        observedAt: new Date(0).toISOString(),
      }
      yield* saveHandoffs(storePath, [persisted])
      // Every completion comes from a merged handoff, so the completion store is under the same
      // gate: a run that cannot finish anything must not write its empty list over this.
      const completionStorePath = join(workspaceRoot, '.sloppenheimer', 'completions.json')
      const finished: CompletedSnapshot = {
        issueId: issueId('74'),
        identifier: 'example/sloppenheimer#74',
        title: 'Merged before handoff was disabled',
        url: null,
        outcome: 'merged',
        finishedAt: new Date(0).toISOString(),
        pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/94',
      }
      yield* saveCompletions(completionStorePath, [finished])
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const harness = makeHarness(isolated)
      const { makeCodeReview: omittedCodeReview, ...trackerOnlyPorts } = harness.ports
      void omittedCodeReview

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', trackerOnlyPorts)
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      expect(snapshot.handoffs).toEqual([])
      expect(snapshot.completed).toEqual([])
      expect(yield* loadHandoffs(storePath)).toEqual([persisted])
      expect(yield* loadCompletions(completionStorePath)).toEqual([finished])
    }),
  )

  it.effect('rejects enabled handoff when the provider does not supply CodeReviewPort', () =>
    Effect.gen(function* () {
      const secondKindWorkflow: Workflow = { ...workflow, tracker: stubProvider('secret') }
      const harness = makeHarness(secondKindWorkflow)
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: () => null,
      }

      const result = yield* Effect.either(
        Effect.scoped(startTestOrchestrator('/tmp/WORKFLOW.md', ports)),
      )

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          category: 'invalid_config',
          message:
            'pull-request handoff is enabled, but tracker provider stub does not supply CodeReviewPort',
        },
      })
    }),
  )

  it.effect('rejects enabled handoff when the provider does not supply SourceControlPort', () =>
    Effect.gen(function* () {
      const harness = makeHarness(workflow)
      const ports: TestPorts = {
        ...harness.ports,
        makeSourceControl: () => null,
      }

      const result = yield* Effect.either(
        Effect.scoped(startTestOrchestrator('/tmp/WORKFLOW.md', ports)),
      )

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          category: 'invalid_config',
          message:
            'pull-request handoff is enabled, but tracker provider github does not supply SourceControlPort',
        },
      })
    }),
  )

  it.effect('interrupts a non-active refreshed issue without removing its workspace', () =>
    Effect.gen(function* () {
      let currentIssue = makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready'])
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

      yield* Effect.scoped(
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
      )
    }),
  )

  it.effect('keeps a running worker when only blocker metadata changes', () =>
    Effect.gen(function* () {
      let currentIssue = makeIssue('example/sloppenheimer#21', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(workflow, () => [currentIssue])
      let resolveStarted = (): void => undefined
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve
      })
      let interrupted = false
      const ports: TestPorts = {
        ...harness.ports,
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
      const blocker: BlockerRef = {
        id: '20',
        identifier: issueIdentifier('example/sloppenheimer#20'),
        title: 'Prerequisite',
        state: 'open',
        url: 'https://github.com/example/sloppenheimer/issues/20',
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* Effect.promise(() => started)
          currentIssue = { ...currentIssue, blockedBy: [blocker] }

          yield* control.refresh

          const snapshot = yield* control.snapshot
          expect(interrupted).toBe(false)
          expect(snapshot.running.map((entry) => entry.issueId)).toEqual([
            'example/sloppenheimer#21',
          ])
        }),
      )
    }),
  )

  it.effect('publishes the saturated issue states and the agents whose detail will answer', () =>
    Effect.gen(function* () {
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
      const issue = makeIssue('example/sloppenheimer#26', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(perStateWorkflow, () => [issue])
      let resolveStarted = (): void => undefined
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve
      })
      const ports: TestPorts = {
        ...harness.ports,
        runAgent: () => Effect.sync(resolveStarted).pipe(Effect.zipRight(Effect.never)),
      }

      yield* Effect.scoped(
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
      )
    }),
  )

  it.effect('reports no saturated state when the workflow sets no per-state limit', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#27', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(workflow, () => [issue])
      let resolveStarted = (): void => undefined
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve
      })
      const ports: TestPorts = {
        ...harness.ports,
        runAgent: () => Effect.sync(resolveStarted).pipe(Effect.zipRight(Effect.never)),
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* Effect.promise(() => started)

          expect((yield* control.snapshot).saturatedStates).toEqual([])
        }),
      )
    }),
  )

  it.effect('updates running snapshot metadata when an active issue refreshes', () =>
    Effect.gen(function* () {
      let currentIssue = makeIssue('example/sloppenheimer#25', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(workflow, () => [currentIssue])
      let resolveStarted = (): void => undefined
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve
      })
      const ports: TestPorts = {
        ...harness.ports,
        runAgent: () => Effect.sync(resolveStarted).pipe(Effect.zipRight(Effect.never)),
      }

      yield* Effect.scoped(
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
            // The issue state travels with the row: SPEC 13.7.2 requires it on a running entry.
            state: 'open',
          })
          // The stall deadline is published absolutely so the console can decide the agent has
          // gone quiet without waiting for a later snapshot to say so.
          const deadline = snapshot.running[0]?.stallDeadline ?? ''
          expect(Number.isNaN(Date.parse(deadline))).toBe(false)
          expect(new Date(deadline).getTime()).toBe(
            new Date(
              snapshot.running[0]?.lastEventAt ?? snapshot.running[0]?.startedAt ?? '',
            ).getTime() + workflow.config.runner.stallTimeoutMs,
          )
        }),
      )
    }),
  )

  it.effect('applies a configured retry cap to an actual failed worker', () =>
    Effect.gen(function* () {
      const cappedWorkflow: Workflow = {
        ...workflow,
        config: {
          ...workflow.config,
          agent: { ...workflow.config.agent, maxRetryBackoffMs: 250 },
        },
      }
      const issue = makeIssue('example/sloppenheimer#26', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(cappedWorkflow, () => [issue])
      let failureAt = 0
      const ports: TestPorts = {
        ...harness.ports,
        runAgent: () =>
          Clock.currentTimeMillis.pipe(
            Effect.tap((now) =>
              Effect.sync(() => {
                failureAt = now
              }),
            ),
            Effect.zipRight(
              Effect.fail(new AgentError({ category: 'process_exited', message: 'test failure' })),
            ),
          ),
      }

      yield* Effect.scoped(
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
      )
    }),
  )

  it.effect('requeues a due retry when another worker occupies the only slot', () =>
    Effect.gen(function* () {
      const retryingIssue = makeIssue('example/sloppenheimer#21', 1, null, [
        'sloppenheimer',
        'ready',
      ])
      const occupyingIssue = makeIssue('example/sloppenheimer#22', 1, null, [
        'sloppenheimer',
        'ready',
      ])
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
            Effect.succeed(
              [retryingIssue, occupyingIssue].filter((issue) => ids.includes(issue.id)),
            ),
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

      yield* Effect.scoped(
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
      )
    }),
  )

  it.effect('finalizes a queued retry rejected by the tracker policy', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#27', 1, null, ['sloppenheimer', 'ready'])
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

      const lookup = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          while ((yield* control.snapshot).retrying.length === 0) {
            yield* Effect.yieldNow()
          }

          yield* TestClock.adjust(10_000)
          yield* Effect.yieldNow()

          return readDetail(control, issue.identifier)
        }),
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
        expect(lookup.detail.timeline.events.map((entry) => entry.category)).toContain(
          'cancellation',
        )
      }
    }),
  )

  it.effect('retains ended usage while a retry starts a fresh absolute counter', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#17', 1, null, ['sloppenheimer', 'ready'])
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

      yield* Effect.scoped(
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
      )
    }),
  )
})

it.scoped('restores a durable running claim without launching a replacement agent', () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-live-durable-')
    const configured: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
    const issue = {
      ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
      id: issueId('167'),
    }
    const path = join(workspaceRoot, 'workflow.sqlite')
    let launches = 0
    const started = yield* Deferred.make<void>()
    const firstHarness = makeHarness(configured, () => [issue])
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openWorkflowStore(path, true)
        const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
          ...firstHarness.ports,
          runAgent: () =>
            Effect.gen(function* () {
              launches += 1
              expect((yield* store.list.pipe(Effect.orDie))[0]?.status._tag).toBe('Executing')
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }),
        }).pipe(Effect.provideService(WorkflowStore, store))
        yield* Deferred.await(started)
        expect((yield* control.snapshot).durableWorkflows?.[0]?.codingAttempts).toBe(1)
      }),
    )
    const store = yield* openWorkflowStore(path, true)
    const nextHarness = makeHarness(configured, () => [issue])
    const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
      ...nextHarness.ports,
      runAgent: () =>
        Effect.sync(() => {
          launches += 1
          return { threadId: 'duplicate', turnId: 'duplicate', turnCount: 1 }
        }),
    }).pipe(Effect.provideService(WorkflowStore, store))
    yield* control.refresh
    yield* TestClock.adjust(60_000)
    yield* control.refresh
    expect(launches).toBe(1)
    expect((yield* control.snapshot).running).toEqual([])
    expect((yield* control.snapshot).durableWorkflows?.[0]?.status._tag).toBe('Intervention')
  }),
)

for (const initiallyEnabled of [false, true]) {
  it.effect(
    'requires restart when verification mode changes from ' + String(initiallyEnabled),
    () =>
      Effect.gen(function* () {
        const enabled: Workflow = {
          ...changedWorkflow({ fingerprint: 'verified' }),
          config: { ...workflow.config, verification: { command: 'pnpm check', timeoutMs: 1_000 } },
        }
        const disabled = changedWorkflow({ fingerprint: 'unverified' })
        const initial = initiallyEnabled ? enabled : disabled
        const harness = makeHarness(initial)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
            yield* control.refresh
            const providers = harness.trackerProviders().length
            harness.setWorkflow(initiallyEnabled ? disabled : enabled)
            yield* control.refresh
            const snapshot = yield* control.snapshot
            expect(snapshot.effectiveWorkflow.fingerprint).toBe(initial.fingerprint)
            expect(snapshot.workflowReloadError?.message).toContain('restart the host')
            expect(harness.trackerProviders().length).toBe(providers)
          }),
        )
      }),
  )
}

it.scoped('dispatches a verified continuation when no code-review port is composed', () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* isolatedWorkspaceRoot('durable-continuation-')
    const configured: Workflow = {
      ...workflow,
      config: {
        ...workflow.config,
        workspaceRoot,
        handoffEnabled: false,
        verification: { command: 'pnpm check', timeoutMs: 1_000 },
      },
    }
    const issue = {
      ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
      id: issueId('167'),
    }
    const harness = makeHarness(configured, () => [issue])
    const { makeCodeReview, ...corePorts } = harness.ports
    void makeCodeReview
    const store = yield* openWorkflowStore(join(workspaceRoot, 'workflow.sqlite'), true)
    let launches = 0
    const second = yield* Deferred.make<void>()
    const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
      ...corePorts,
      makeSourceControl: (): SourceControlPort => ({
        prepare: (_issue, workspace, target) =>
          Effect.succeed({
            workspace,
            target,
            baseBranch: 'main',
            baseSha: 'base',
            baselineSha: 'base',
            expectedRemoteHead: Option.none(),
          }),
        inspect: () => Effect.succeed(changedWorktree),
        publish: () => Effect.die('must use verified publication'),
        rebase: () => Effect.die('no handoff to rebase'),
        candidates: {
          checkpoint: (_issue, prepared) =>
            Effect.succeed(
              Option.some({
                prepared,
                headSha: 'candidate',
                treeSha: 'tree',
                commitCreated: true,
              }),
            ),
          observe: () => Effect.succeed({ _tag: 'Unpublished' }),
          align: (candidate) => Effect.succeed(candidate),
          verify: (candidate) =>
            Effect.succeed({
              candidate,
              evidence: {
                headSha: candidate.headSha,
                treeSha: candidate.treeSha,
                command: 'pnpm check',
                verifiedAt: 0,
              },
            }),
          publish: (verified) =>
            Effect.succeed({
              _tag: 'Published',
              headSha: verified.candidate.headSha,
              branchName: verified.candidate.prepared.target.branchName,
              commitCreated: true,
            }),
        },
      }),
      runAgent: () =>
        Effect.gen(function* () {
          launches += 1
          if (launches === 2) {
            yield* Deferred.succeed(second, undefined)
            return yield* Effect.never
          }
          return { threadId: 'thread', turnId: 'turn', turnCount: 1 }
        }),
    }).pipe(Effect.provideService(WorkflowStore, store))
    while ((yield* control.snapshot).retrying.length === 0) {
      yield* Effect.yieldNow()
    }
    expect((yield* store.list)[0]?.status).toMatchObject({
      _tag: 'Waiting',
      condition: 'continuation',
    })
    yield* TestClock.adjust(1_001)
    yield* Deferred.await(second)
    expect(launches).toBe(2)
    expect((yield* store.list)[0]?.codingAttempts).toBe(2)
  }),
)

it.effect('reloads verification command changes without changing durable mode', () =>
  Effect.gen(function* () {
    const initial: Workflow = {
      ...changedWorkflow({ fingerprint: 'first-gate' }),
      config: { ...workflow.config, verification: { command: 'pnpm check', timeoutMs: 1_000 } },
    }
    const reloaded: Workflow = {
      ...initial,
      fingerprint: 'new-gate',
      config: { ...initial.config, verification: { command: 'pnpm test', timeoutMs: 2_000 } },
    }
    const harness = makeHarness(initial)
    yield* Effect.scoped(
      Effect.gen(function* () {
        const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
        yield* control.refresh
        harness.setWorkflow(reloaded)
        yield* control.refresh
        expect((yield* control.snapshot).effectiveWorkflow.fingerprint).toBe('new-gate')
        expect((yield* control.snapshot).workflowReloadError).toBeNull()
      }),
    )
  }),
)

for (const composedEnabled of [false, true]) {
  it.scoped(
    'rejects verification mode changing between composition and bootstrap, composed=' +
      String(composedEnabled),
    () =>
      Effect.gen(function* () {
        const initial: Workflow = {
          ...workflow,
          config: {
            ...workflow.config,
            ...(composedEnabled ? { verification: { command: 'true', timeoutMs: 1_000 } } : {}),
          },
        }
        const next: Workflow = {
          ...workflow,
          config: {
            ...workflow.config,
            ...(!composedEnabled ? { verification: { command: 'true', timeoutMs: 1_000 } } : {}),
          },
        }
        const harness = makeHarness(initial)
        harness.setWorkflow(next)
        const error = yield* Effect.flip(
          startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports).pipe(
            Effect.provideService(WorkflowComposition, { verificationEnabled: composedEnabled }),
          ),
        )
        expect(error).toMatchObject({ category: 'invalid_config' })
        expect(error.message).toContain('restart required')
        expect(harness.trackerProviders()).toHaveLength(1)
      }),
  )
}

it.effect('waits for after_run on shutdown before releasing the workspace', () =>
  Effect.gen(function* () {
    const issue = makeIssue('example/sloppenheimer#24', 1, null, ['sloppenheimer', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    const started = yield* Deferred.make<void>()
    const hookStarted = yield* Deferred.make<void>()
    const allowCleanup = yield* Deferred.make<void>()
    const events: string[] = []
    const task = yield* Effect.fork(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            makeWorkspaces: (settings): WorkspaceManagerPort => ({
              ...harness.ports.makeWorkspaces(settings),
              afterRun: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(hookStarted, undefined)
                  yield* Deferred.await(allowCleanup)
                  events.push('after_run')
                }),
            }),
            runAgent: () =>
              Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never)),
          })
          yield* Deferred.await(started)
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            events.push('scope_closed')
          }),
        ),
      ),
    )
    yield* Deferred.await(hookStarted)
    expect(events).toEqual([])
    yield* Deferred.succeed(allowCleanup, undefined)
    yield* Fiber.join(task)
    expect(events).toEqual(['after_run', 'scope_closed'])
  }),
)

for (const initiallyPaused of [false, true]) {
  it.scoped(
    'resumes the durable handoff after a crash between push and PR creation, paused=' +
      String(initiallyPaused),
    () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* isolatedWorkspaceRoot('durable-handoff-')
        const configured: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
        const issue = {
          ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
          id: issueId('167'),
        }
        const branchName = 'sloppenheimer/issue-167'
        const store = yield* openWorkflowStore(join(workspaceRoot, 'workflow.sqlite'), true)
        const host = yield* makeDurableHost(store)
        const target = { _tag: 'Normal', branchName } as const
        const journal = yield* host.start(issue, target).pipe(Effect.map(Option.getOrThrow))
        const prepared = {
          target,
          workspace: { path: workspaceRoot, key: 'retained' },
          baseBranch: 'main',
          baselineSha: 'base',
          baseSha: 'base',
          expectedRemoteHead: Option.none<string>(),
        }
        yield* journal.prepared(prepared)
        yield* journal.publication.verified({
          candidate: { prepared, headSha: 'candidate', treeSha: 'tree', commitCreated: true },
          evidence: { headSha: 'candidate', treeSha: 'tree', command: 'true', verifiedAt: 0 },
        })
        yield* journal.publication.published({
          _tag: 'Published',
          branchName,
          headSha: 'candidate',
          commitCreated: true,
        })
        if (initiallyPaused) {
          yield* host.setIntent(issue.identifier, 'paused')
        }
        const harness = makeHarness(configured, () => [issue])
        let created = 0
        let exists = false
        const result = {
          _tag: 'PullRequest',
          branchName,
          pullRequestNumber: 42,
          pullRequestUrl: 'https://github.com/example/sloppenheimer/pull/42',
          created: true,
        } as const
        const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
          ...harness.ports,
          runAgent: () => Effect.die('published work must not launch another agent'),
          makeCodeReview: (provider): CodeReviewPort => ({
            ...requireCodeReview(harness.ports, provider),
            findExistingHandoff: () =>
              Effect.sync(() =>
                exists ? { ...result, created: false } : { _tag: 'NoBranch', branchName },
              ),
            handoffCompletedWork: () =>
              Effect.gen(function* () {
                created += 1
                exists = true
                return yield* Effect.fail(
                  new TrackerError({
                    category: 'tracker_request',
                    message: 'create acknowledgement lost',
                    retryable: true,
                  }),
                )
              }),
            inspectPullRequest: () =>
              Effect.succeed(
                anOpenPullRequest({
                  number: 42,
                  headSha: 'candidate',
                  codexReview: { headSha: 'candidate', status: 'completed' },
                  checks: [{ name: 'quality', status: 'in_progress', conclusion: null, url: null }],
                }),
              ),
          }),
        }).pipe(Effect.provideService(WorkflowStore, store))
        yield* control.refresh
        if (initiallyPaused) {
          expect(created).toBe(0)
          yield* control.setIssuePaused(167, false)
        }
        yield* control.refresh
        yield* control.refresh
        expect(created).toBe(1)
        expect((yield* control.snapshot).handoffs).toHaveLength(1)
        expect((yield* control.snapshot).durableWorkflows?.[0]?.artifact?.publishedHead).toBe(
          'candidate',
        )
      }),
  )
}

it.scoped(
  're-enrolls a stopped retained verified candidate after restart without another agent',
  () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('durable-publication-recovery-')
      const configured: Workflow = {
        ...workflow,
        config: {
          ...workflow.config,
          workspaceRoot,
          verification: { command: 'true', timeoutMs: 1_000 },
        },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#288', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('288'),
      }
      const target = { _tag: 'Normal', branchName: 'sloppenheimer/issue-288' } as const
      const prepared = {
        target,
        workspace: { path: join(workspaceRoot, 'GH-288', 'run-1-old'), key: 'run-1-old' },
        repositoryIdentity: 'example/sloppenheimer',
        baseBranch: 'main',
        baseSha: 'base',
        baselineSha: 'base',
        expectedRemoteHead: Option.none<string>(),
      }
      const candidate = { prepared, headSha: 'candidate', treeSha: 'tree', commitCreated: true }
      const verified = {
        candidate,
        evidence: { headSha: 'candidate', treeSha: 'tree', command: 'true', verifiedAt: 0 },
      }
      const store = yield* openWorkflowStore(join(workspaceRoot, 'workflow.sqlite'), true)
      const previous = yield* makeDurableHost(store)
      const journal = yield* previous.start(issue, target).pipe(Effect.map(Option.getOrThrow))
      yield* journal.prepared(prepared)
      yield* journal.publication.verified(verified)

      const harness = makeHarness(configured, () => [issue])
      let publications = 0
      let supervised = 0
      const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
        ...harness.ports,
        runAgent: () => Effect.die('recovery must not launch a coding agent'),
        makeWorkspaces: (settings): WorkspaceManagerPort => ({
          ...harness.ports.makeWorkspaces(settings),
          confirmStopped: () => Effect.succeed(true),
          superviseCaptured: (_workspace, operation) =>
            Effect.sync(() => {
              supervised += 1
            }).pipe(Effect.zipRight(operation)),
        }),
        makeSourceControl: (): SourceControlPort => ({
          recovery: {
            repositoryIdentity: 'example/sloppenheimer',
            observeHead: () => Effect.succeed(Option.none()),
          },
          prepare: () => Effect.die('recovery uses captured preparation'),
          inspect: () => Effect.succeed(changedWorktree),
          publish: () => Effect.die('verified recovery uses candidate publication'),
          rebase: () => Effect.die('recovery must not rebase'),
          candidates: {
            checkpoint: () => Effect.succeed(Option.some(candidate)),
            align: () => Effect.succeed(candidate),
            verify: () => Effect.succeed(verified),
            observe: () => Effect.succeed({ _tag: 'Unpublished' }),
            publish: () =>
              Effect.sync(() => {
                publications += 1
                return {
                  _tag: 'Published',
                  branchName: target.branchName,
                  headSha: candidate.headSha,
                  commitCreated: true,
                } as const
              }),
          },
        }),
      }).pipe(Effect.provideService(WorkflowStore, store))

      let snapshot = yield* control.snapshot
      while (snapshot.delivering.length === 0) {
        yield* Effect.yieldNow()
        snapshot = yield* control.snapshot
      }
      const delivery = snapshot.delivering[0]
      if (delivery === undefined) {
        return yield* Effect.die('recovery must schedule the retained candidate')
      }
      yield* TestClock.setTime(new Date(delivery.dueAt).getTime())
      while (
        publications === 0 ||
        (yield* control.snapshot).durableWorkflows?.[0]?.artifact?.publishedHead !== 'candidate'
      ) {
        yield* Effect.yieldNow()
      }
      expect(publications).toBe(1)
      expect(supervised).toBeGreaterThanOrEqual(2)
      expect((yield* control.snapshot).durableWorkflows?.[0]?.artifact?.publishedHead).toBe(
        'candidate',
      )
    }),
)

it.scoped(
  'shows intervention when a durable delivery becomes terminal without deleting its candidate',
  () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('durable-terminal-')
      const configured: Workflow = {
        ...workflow,
        config: {
          ...workflow.config,
          workspaceRoot,
          verification: { command: 'true', timeoutMs: 1_000 },
        },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      let currentIssue = issue
      const harness = makeHarness(configured, () => [currentIssue])
      let launches = 0
      let publications = 0
      let removals = 0
      const store = yield* openWorkflowStore(join(workspaceRoot, 'workflow.sqlite'), true)
      const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
        ...harness.ports,
        makeWorkspaces: (settings): WorkspaceManagerPort => ({
          ...harness.ports.makeWorkspaces(settings),
          remove: () =>
            Effect.sync(() => {
              removals += 1
            }),
        }),
        makeSourceControl: (): SourceControlPort => ({
          prepare: (_issue, workspace, target) =>
            Effect.succeed({
              workspace,
              target,
              baseBranch: 'main',
              baseSha: 'base',
              baselineSha: 'base',
              expectedRemoteHead: Option.none(),
            }),
          inspect: () => Effect.succeed(launches === 0 ? cleanWorktree('base') : changedWorktree),
          publish: () => Effect.die('must use verified publication'),
          rebase: () => Effect.die('no handoff'),
          candidates: {
            checkpoint: (_issue, prepared) =>
              Effect.succeed(
                Option.some({
                  prepared,
                  headSha: 'candidate',
                  treeSha: 'tree',
                  commitCreated: true,
                }),
              ),
            observe: () => Effect.succeed({ _tag: 'Unpublished' }),
            align: (candidate) => Effect.succeed(candidate),
            verify: (candidate) =>
              Effect.succeed({
                candidate,
                evidence: {
                  headSha: candidate.headSha,
                  treeSha: candidate.treeSha,
                  command: 'true',
                  verifiedAt: 0,
                },
              }),
            publish: () =>
              Effect.gen(function* () {
                publications += 1
                return yield* Effect.fail(
                  new SourceControlError({
                    category: 'publication_failed',
                    message: 'network refused',
                    retryable: true,
                    worktreePreserved: true,
                  }),
                )
              }),
          },
        }),
        runAgent: () =>
          Effect.sync(() => {
            launches += 1
            return { threadId: 'thread', turnId: 'turn', turnCount: 1 }
          }),
      }).pipe(Effect.provideService(WorkflowStore, store))
      let snapshot = yield* control.snapshot
      while (snapshot.delivering.length === 0) {
        yield* Effect.yieldNow()
        snapshot = yield* control.snapshot
      }
      const delivery = snapshot.delivering[0]
      if (delivery === undefined) {
        return yield* Effect.die('fixture must retain a delivery')
      }
      currentIssue = { ...issue, state: 'closed' }
      yield* TestClock.setTime(new Date(delivery.dueAt).getTime())
      while ((yield* control.snapshot).delivering[0]?.interventionRequired !== true) {
        yield* Effect.yieldNow()
      }
      snapshot = yield* control.snapshot
      expect(snapshot.delivering[0]).toMatchObject({
        interventionRequired: true,
        category: 'publication_blocked',
      })
      expect(snapshot.durableWorkflows?.[0]?.status).toMatchObject({
        _tag: 'Intervention',
        reason:
          'Candidate retained: Issue is no longer active. Durable candidate retained; cleanup requires reconciliation.',
      })
      expect(publications).toBe(1)
      expect(launches).toBe(1)
      expect(removals).toBe(0)
    }),
)

const retryTestSource = (): SourceControlPort => ({
  prepare: (_issue, workspace, target) =>
    Effect.succeed({
      workspace,
      target,
      baseBranch: 'main',
      baseSha: 'base',
      baselineSha: 'base',
      expectedRemoteHead: Option.none(),
    }),
  inspect: () => Effect.succeed(cleanWorktree('base')),
  publish: () => Effect.die('retry test must not publish'),
  rebase: () => Effect.die('retry test must not rebase'),
})

for (const failureStage of ['prepare', 'before_run', 'agent']) {
  it.scoped('durably admits the scheduled retry after a clean ' + failureStage + ' failure', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('durable-failure-retry-')
      const configured: Workflow = {
        ...workflow,
        config: {
          ...workflow.config,
          workspaceRoot,
          verification: { command: 'true', timeoutMs: 1_000 },
        },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      const harness = makeHarness(configured, () => [issue])
      const store = yield* openWorkflowStore(join(workspaceRoot, 'workflow.sqlite'), true)
      const retried = yield* Deferred.make<void>()
      let preparations = 0
      let hooks = 0
      let launches = 0
      const source = retryTestSource()
      const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
        ...harness.ports,
        makeSourceControl: (): SourceControlPort => ({
          ...source,
          prepare: (issue, workspace, target) =>
            Effect.gen(function* () {
              preparations += 1
              if (failureStage === 'prepare' && preparations === 1) {
                return yield* Effect.fail(
                  new SourceControlError({
                    category: 'prepare_failed',
                    message: 'temporary failure',
                    retryable: true,
                    worktreePreserved: true,
                  }),
                )
              }
              return yield* source.prepare(issue, workspace, target)
            }),
        }),
        makeWorkspaces: (settings): WorkspaceManagerPort => ({
          ...harness.ports.makeWorkspaces(settings),
          beforeRun: () =>
            Effect.gen(function* () {
              hooks += 1
              if (failureStage === 'before_run' && hooks === 1) {
                return yield* Effect.fail(
                  new WorkspaceError({
                    category: 'hook_failed',
                    message: 'temporary hook failure',
                  }),
                )
              }
            }),
        }),
        runAgent: () =>
          Effect.gen(function* () {
            launches += 1
            if (failureStage === 'agent' && launches === 1) {
              return yield* Effect.fail(
                new AgentError({ category: 'turn_timeout', message: 'clean agent timeout' }),
              )
            }
            yield* Deferred.succeed(retried, undefined)
            return yield* Effect.never
          }),
      }).pipe(Effect.provideService(WorkflowStore, store))
      let snapshot = yield* control.snapshot
      while (snapshot.retrying.length === 0) {
        yield* Effect.yieldNow()
        snapshot = yield* control.snapshot
      }
      expect(snapshot.durableWorkflows?.[0]?.status).toMatchObject({
        _tag: 'Waiting',
        condition: 'retry',
      })
      const retry = snapshot.retrying[0]
      if (retry === undefined) {
        return yield* Effect.die('fixture must schedule retry')
      }
      yield* TestClock.setTime(new Date(retry.dueAt).getTime())
      yield* Deferred.await(retried)
      expect(preparations).toBe(2)
      expect((yield* control.snapshot).durableWorkflows?.[0]?.codingAttempts).toBe(2)
    }),
  )
}

for (const partial of [false, true]) {
  it.scoped(
    'settles a paused worker after cleanup and before resume, partial=' + String(partial),
    () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* isolatedWorkspaceRoot('durable-pause-resume-')
        const configured: Workflow = {
          ...workflow,
          config: {
            ...workflow.config,
            workspaceRoot,
            verification: { command: 'true', timeoutMs: 1_000 },
          },
        }
        const issue = {
          ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
          id: issueId('167'),
        }
        const harness = makeHarness(configured, () => [issue])
        const store = yield* openWorkflowStore(join(workspaceRoot, 'workflow.sqlite'), true)
        const started = yield* Deferred.make<void>()
        const restarted = yield* Deferred.make<void>()
        let launches = 0
        let cleaned = false
        const source = retryTestSource()
        const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
          ...harness.ports,
          makeSourceControl: (): SourceControlPort => ({
            ...source,
            inspect: () =>
              Effect.sync(() => {
                if (launches > 0) {
                  expect(cleaned).toBe(true)
                }
                return partial && launches > 0 ? changedWorktree : cleanWorktree('base')
              }),
          }),
          makeWorkspaces: (settings): WorkspaceManagerPort => ({
            ...harness.ports.makeWorkspaces(settings),
            afterRun: () =>
              Effect.sync(() => {
                cleaned = true
              }),
          }),
          runAgent: () =>
            Effect.gen(function* () {
              launches += 1
              cleaned = false
              yield* Deferred.succeed(launches === 1 ? started : restarted, undefined)
              return yield* Effect.never
            }),
        }).pipe(Effect.provideService(WorkflowStore, store))
        yield* Deferred.await(started)
        yield* control.setIssuePaused(167, true)

        yield* control.refresh
        const paused = yield* control.snapshot
        expect(cleaned).toBe(true)
        expect(paused.running).toEqual([])
        expect(paused.durableWorkflows?.[0]?.intent).toBe('paused')
        expect(paused.durableWorkflows?.[0]?.status._tag).toBe(partial ? 'Intervention' : 'Waiting')
        yield* control.setIssuePaused(167, false)

        yield* control.refresh
        yield* control.refresh
        if (partial) {
          expect(launches).toBe(1)
          expect((yield* control.snapshot).durableWorkflows?.[0]?.artifact).not.toBeNull()
        } else {
          yield* Deferred.await(restarted)
          expect(launches).toBe(2)
        }
      }),
  )
}

it.scoped('acknowledges durable intent while a tracker read parks the controller', () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* isolatedWorkspaceRoot('responsive-intent-')
    const issue = makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready'])
    const harness = makeHarness(
      { ...workflow, config: { ...workflow.config, workspaceRoot } },
      () => [issue],
    )
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let parked = false
    const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
      ...harness.ports,
      makeTracker: (provider) => {
        const tracker = harness.ports.makeTracker(provider)
        return {
          ...tracker,
          fetchIssuesByIds: (ids, options): ReturnType<TrackerPort['fetchIssuesByIds']> =>
            Effect.gen(function* () {
              if (parked) {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              }
              return yield* tracker.fetchIssuesByIds(ids, options)
            }),
        } satisfies TrackerPort
      },
    })
    yield* harness.awaitAgentRun
    parked = true
    const refresh = yield* control.refresh.pipe(Effect.fork)
    yield* Deferred.await(entered)
    yield* control.setIssuePaused(167, true)
    yield* control.setIssuePaused(999, true)
    expect((yield* control.snapshot).pausedIssueNumbers).toEqual([167, 999])
    parked = false
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(refresh)
    yield* control.refresh
    expect((yield* control.snapshot).running).toEqual([])
  }),
)
