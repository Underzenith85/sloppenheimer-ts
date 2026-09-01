import type { FileSystem } from '@effect/platform'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import {
  Clock,
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
import type { WorkspaceRelease } from '@sloppenheimer/core/domain/workspace-lease.js'
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
    return base
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
          Effect.succeed(
            makeSourceControl === undefined ? sourceControl : makeSourceControl(provider),
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
    codexReview: { headShaPrefix: headSha.slice(0, 7), status: 'completed' },
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
  })

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
          // Well past the delivery backoff. A pause is a decision to stop, so nothing is pushed —
          // and the work is still there, rather than discarded with the attempt that was waiting.
          yield* TestClock.adjust('5 minutes')
          snapshot = yield* control.snapshot
          expect(publications).toEqual(['sloppenheimer/issue-167'])
          expect(snapshot.delivering).toHaveLength(1)
          expect(snapshot.retrying).toEqual([])

          yield* control.setIssuePaused(167, false)
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
          // Small enough that the whole budget fits inside one TestClock advance per attempt.
          agent: { ...workflow.config.agent, maxRetryBackoffMs: 10_000 },
        },
      }
      const rooted: Workflow = { ...isolated, config: { ...isolated.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#167', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('167'),
      }
      const harness = makeHarness(rooted, () => [issue])
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
        runAgent: () => {
          launched += 1
          return Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 })
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let snapshot = yield* control.snapshot
          while (snapshot.retrying.length === 0) {
            // One step per delivery backoff, so the run that follows the spent budget cannot start
            // inside the same advance and add publications of its own.
            yield* TestClock.adjust('11 seconds')
            yield* Effect.yieldNow()
            snapshot = yield* control.snapshot
          }

          // Five publications in total, the turn's own included, and then the work goes back to
          // the coding agent rather than being retried forever or dropped.
          expect(publications).toHaveLength(deliveryAttemptLimit)
          expect(snapshot.delivering).toEqual([])
          expect(snapshot.retrying[0]?.error).toContain('delivery failed')
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
                codexReview: { headShaPrefix: 'recovered-head', status: 'pending' as const },
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
                headShaPrefix: number === 65 ? 'first-head' : 'second-head',
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
              codexReview: { headShaPrefix: 'persisted-head', status: 'pending' as const },
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
          identifier: issue.identifier,
          pullRequestUrl: `https://github.test/example/sloppenheimer/pull/${65 + index}`,
          branchName: `sloppenheimer/issue-${issue.id}`,
          state: 'repair_needed' as const,
          headSha: head,
          reason: 'The pull request conflicts with protected main',
          repairAttempts: 0,
          repairHeadShas: [],
          repairStartedHeadSha: null,
          reviewRequestedHeadSha: head,
          reviewCompletedHeadSha: head,
          observedAt: new Date(0).toISOString(),
        })),
      )
      const harness = makeHarness(isolated, () => [failedIssue, healthyIssue])
      const refreshedIds: IssueId[] = []
      const launchedIds: IssueId[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeTracker: (provider) => {
          const tracker = harness.ports.makeTracker(provider)
          return {
            ...tracker,
            fetchIssuesByIds: (ids, options) => {
              if (ids.length !== 1) {
                return tracker.fetchIssuesByIds(ids, options)
              }
              refreshedIds.push(...ids)
              if (ids.includes(failedIssue.id)) {
                return Effect.fail(
                  new TrackerError({
                    category: 'tracker_request',
                    message: 'one issue is malformed',
                    retryable: true,
                  }),
                )
              }
              return Effect.succeed([healthyIssue])
            },
          }
        },
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        runAgent: ({ issue }) =>
          Effect.sync(() => {
            launchedIds.push(issue.id)
          }).pipe(Effect.zipRight(Effect.never)),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          while (launchedIds.length === 0) {
            yield* Effect.yieldNow()
          }
          return yield* control.snapshot
        }),
      )

      expect(refreshedIds).toEqual([failedIssue.id, healthyIssue.id])
      expect(launchedIds).toEqual([healthyIssue.id])
      expect(
        snapshot.handoffs.find((handoff) => handoff.issueId === failedIssue.id)?.reason,
      ).toContain('one issue is malformed')
    }),
  )

  it.scoped('awaits Codex review of the initial head before merging', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-initial-review-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = {
        ...workflow,
        config: { ...workflow.config, workspaceRoot },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
        dispatchable: false,
      }
      const initialHead = 'abcdef1234567890abcdef1234567890abcdef12'
      yield* saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
          branchName: 'sloppenheimer/issue-20',
          state: 'awaiting_checks',
          headSha: initialHead,
          reason: null,
          repairAttempts: 0,
          reviewRequestedHeadSha: null,
          reviewCompletedHeadSha: null,
          observedAt: new Date(0).toISOString(),
        },
      ])
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
              url: 'https://github.test/example/sloppenheimer/pull/65',
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

      yield* Effect.scoped(
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
      )
    }),
  )

  it.scoped('requests and awaits Codex review of the repaired head before merging', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repaired-review-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = {
        ...workflow,
        config: { ...workflow.config, workspaceRoot },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
        dispatchable: false,
      }
      const repairedHead = 'abcdef1234567890abcdef1234567890abcdef12'
      yield* saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
          branchName: 'sloppenheimer/issue-20',
          state: 'awaiting_checks',
          headSha: repairedHead,
          reason: null,
          repairAttempts: 1,
          reviewRequestedHeadSha: null,
          observedAt: new Date(0).toISOString(),
        },
      ])
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
              url: 'https://github.test/example/sloppenheimer/pull/65',
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

      yield* Effect.scoped(
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
      )
    }),
  )

  it.scoped(
    'migrates contaminated legacy counts and persists the repair baseline while running',
    () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-running-repair-')
        const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
        const isolated: Workflow = {
          ...workflow,
          config: { ...workflow.config, workspaceRoot },
        }
        const issue = {
          ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
          id: issueId('20'),
        }
        const reviewedHead = 'abcdef1234567890abcdef1234567890abcdef12'
        yield* saveHandoffs(handoffStorePath, [
          {
            issueId: issue.id,
            identifier: issue.identifier,
            pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
            branchName: 'sloppenheimer/issue-20',
            state: 'intervention_required',
            headSha: reviewedHead,
            reason: 'Repair limit reached. Unresolved review feedback',
            repairAttempts: 3,
            reviewRequestedHeadSha: reviewedHead,
            reviewCompletedHeadSha: reviewedHead,
            observedAt: new Date(0).toISOString(),
          },
        ])
        const harness = makeHarness(isolated, () => [issue])
        const ports: TestPorts = {
          ...harness.ports,
          makeCodeReview: (provider) => ({
            ...requireCodeReview(harness.ports, provider),
            inspectPullRequest: (number) =>
              Effect.succeed({
                number,
                state: 'open' as const,
                url: 'https://github.test/example/sloppenheimer/pull/65',
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
                    outdated: false,
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

        const snapshot = yield* Effect.scoped(
          Effect.gen(function* () {
            const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
            yield* control.refresh
            return yield* control.snapshot
          }),
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
        expect(yield* loadHandoffs(handoffStorePath)).toEqual([
          expect.objectContaining({
            issueId: '20',
            repairAttempts: 0,
            repairHeadShas: [],
            repairStartedHeadSha: reviewedHead,
          }),
        ])
      }),
  )

  it.scoped('counts a repair only after GitHub exposes a distinct pull request head', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-progress-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const originalHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const repairedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      let currentHead = originalHead
      yield* saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
          branchName: 'sloppenheimer/issue-20',
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
      ])
      const harness = makeHarness(isolated, () => [issue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.succeed({
              number,
              state: 'open' as const,
              url: 'https://github.test/example/sloppenheimer/pull/65',
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
                        outdated: false,
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
              branchName: 'sloppenheimer/issue-20',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
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

      const snapshot = yield* Effect.scoped(
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
      )

      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 1,
        repairHeadShas: [repairedHead],
        repairStartedHeadSha: null,
      })
    }),
  )

  it.scoped('releases a no-op repair claim when the handoff reaches intervention required', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-no-progress-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
          branchName: 'sloppenheimer/issue-20',
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
      ])
      const harness = makeHarness(isolated, () => [issue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.succeed({
              number,
              state: 'open' as const,
              url: 'https://github.test/example/sloppenheimer/pull/65',
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
              branchName: 'sloppenheimer/issue-20',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
              pullRequestNumber: 65,
              created: false,
            }),
        }),
        // A repair that achieved nothing, stated as the host can verify it: the worktree came back
        // matching its baseline. Only that reading earns the no-progress verdict below — an
        // unchanged pull-request head on its own could equally be a publication that failed.
        makeSourceControl: () => ({
          prepare: (_candidate, workspace, target) =>
            Effect.succeed({
              workspace,
              target,
              baseBranch: 'main',
              baseSha: 'protected-main',
              baselineSha: head,
              expectedRemoteHead: Option.some(head),
            }),
          inspect: (prepared) => Effect.succeed(cleanWorktree(prepared.baselineSha)),
          publish: (_candidate, prepared) =>
            Effect.succeed({
              _tag: 'NoChanges',
              branchName: prepared.target.branchName,
              baselineSha: prepared.baselineSha,
            }),
        }),
        runAgent: () => Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
      }

      const snapshot = yield* Effect.scoped(
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
      )

      expect(snapshot.running).toEqual([
        expect.objectContaining({ issueId: issue.id, identifier: issue.identifier }),
      ])
      expect(snapshot.retrying).toEqual([])
      expect(snapshot.handoffs[0]).toMatchObject({
        state: 'intervention_required',
        repairAttempts: 0,
        repairHeadShas: [],
        repairStartedHeadSha: null,
      })
      expect(snapshot.handoffs[0]?.reason).toContain(
        'Repair agent completed without changing the pull request head',
      )
    }),
  )

  it.scoped('attributes a repair head pushed just before a restart', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-restart-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const originalHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const repairedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      // The repair pushed repairedHead, then the process died before reconciliation observed it.
      yield* saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
          branchName: 'sloppenheimer/issue-20',
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
      ])
      const harness = makeHarness(isolated, () => [issue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.succeed({
              number,
              state: 'open' as const,
              url: 'https://github.test/example/sloppenheimer/pull/65',
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
              branchName: 'sloppenheimer/issue-20',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
              pullRequestNumber: 65,
              created: false,
            }),
        }),
        runAgent: () => Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 1,
        repairHeadShas: [repairedHead],
        repairStartedHeadSha: null,
      })
    }),
  )

  it.scoped('detects a repair cycle back to the pre-repair head', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-cycle-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const initialHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const repairedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      // The first repair moved the branch off initialHead; the second put it back. initialHead was
      // only ever a baseline, so it is the head the budget counter alone cannot remember.
      yield* saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
          branchName: 'sloppenheimer/issue-20',
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
      ])
      const harness = makeHarness(isolated, () => [issue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.succeed({
              number,
              state: 'open' as const,
              url: 'https://github.test/example/sloppenheimer/pull/65',
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
              branchName: 'sloppenheimer/issue-20',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
              pullRequestNumber: 65,
              created: false,
            }),
        }),
        runAgent: () => Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      // Returning to an already observed head is a cycle, not progress: it must not buy another
      // repair or another slot in the budget.
      expect(snapshot.handoffs[0]).toMatchObject({
        state: 'intervention_required',
        repairAttempts: 1,
      })
      expect(snapshot.handoffs[0]?.reason).toContain('already observed repair head')
    }),
  )

  it.scoped('treats a repair interrupted by a restart as retryable, not a no-op', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-interrupted-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      // The repair was dispatched and its baseline persisted, then the process died before the
      // agent pushed anything. The head is therefore unchanged, but nothing was a no-op.
      yield* saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
          branchName: 'sloppenheimer/issue-20',
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
      ])
      const harness = makeHarness(isolated, () => [issue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.succeed({
              number,
              state: 'open' as const,
              url: 'https://github.test/example/sloppenheimer/pull/65',
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
                  outdated: false,
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
              branchName: 'sloppenheimer/issue-20',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
              pullRequestNumber: 65,
              created: false,
            }),
        }),
        runAgent: () => Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      // The interrupted repair neither consumed the changed-head budget nor locked the handoff out
      // of further automatic repairs.
      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 0,
        repairHeadShas: [],
      })
      expect(snapshot.handoffs[0]?.state).not.toBe('intervention_required')
    }),
  )

  it.scoped('releases a running repair identity when the operator cancels it', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-cancelled-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [issue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        runAgent: () => Effect.never,
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.running.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          expect(current.handoffs[0]?.repairStartedHeadSha).toBe(head)
          yield* control.setIssuePaused(20, true)
          return yield* control.snapshot
        }),
      )

      expect(snapshot.handoffs[0]).toMatchObject({
        state: 'repair_needed',
        repairAttempts: 0,
        repairStartedHeadSha: null,
      })
      expect(yield* loadHandoffs(handoffStorePath)).toEqual([
        expect.objectContaining({ repairStartedHeadSha: null }),
      ])
    }),
  )

  it.scoped('retains a stalled repair identity for its automatic retry', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-stalled-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = {
        ...workflow,
        config: {
          ...workflow.config,
          workspaceRoot,
          runner: { ...workflow.config.runner, stallTimeoutMs: 1 },
        },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [issue])
      const launchedDescriptions: (string | null)[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        runAgent: ({ issue: launchedIssue }) =>
          Effect.sync(() => {
            launchedDescriptions.push(launchedIssue.description)
          }).pipe(Effect.zipRight(Effect.never)),
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          while (launchedDescriptions.length === 0) {
            yield* Effect.yieldNow()
          }
          // Past the one-millisecond stall bound, which the orchestrator now measures against the
          // same clock this test drives.
          yield* TestClock.adjust(2)
          yield* control.refresh
          let current = yield* control.snapshot
          expect(current.running).toEqual([])
          expect(current.retrying).toHaveLength(1)
          expect(current.handoffs[0]?.repairStartedHeadSha).toBe(head)

          yield* TestClock.adjust('30 seconds')
          while (launchedDescriptions.length < 2) {
            yield* Effect.yieldNow()
          }
          current = yield* control.snapshot
          expect(launchedDescriptions[1]).toContain('## Pull request repair')
          expect(launchedDescriptions[1]).toContain(`Head: ${head}`)
          expect(current.handoffs[0]?.repairStartedHeadSha).toBe(head)
          yield* control.setIssuePaused(20, true)
        }),
      )
    }),
  )

  it.scoped('refreshes and attributes a repair whose first dispatch was refused', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-refused-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = {
        ...workflow,
        promptTemplate: '{{ issue.description }}',
        config: { ...workflow.config, workspaceRoot },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const originalHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const queuedHead = 'cccccccccccccccccccccccccccccccccccccccc'
      const repairedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      let currentHead = originalHead
      yield* saveRepairHandoff(handoffStorePath, issue, originalHead)
      const harness = makeHarness(isolated, () => [issue])
      const refuseRepairDispatch = armFirstRepairDispatchRefusal(harness)
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.sync(() => {
              refuseRepairDispatch()
              return repairObservation(number, currentHead)
            }),
          handoffCompletedWork: () =>
            Effect.succeed({
              _tag: 'PullRequest' as const,
              branchName: 'sloppenheimer/issue-20',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
              pullRequestNumber: 65,
              created: false,
            }),
        }),
        runAgent: ({ issue: launchedIssue }) =>
          Effect.sync(() => {
            expect(launchedIssue.description).toContain(`Head: ${queuedHead}`)
            currentHead = repairedHead
            return { threadId: 'thread', turnId: 'turn', turnCount: 1 }
          }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          expect(current.handoffs[0]?.repairStartedHeadSha).toBe(originalHead)
          currentHead = queuedHead
          yield* TestClock.adjust('20 seconds')
          while (current.handoffs[0]?.repairAttempts !== 1) {
            yield* Effect.yieldNow()
            yield* control.refresh
            current = yield* control.snapshot
          }
          return current
        }),
      )

      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 1,
        repairHeadShas: [repairedHead],
        repairObservedHeadShas: [originalHead, queuedHead, repairedHead],
        repairStartedHeadSha: null,
      })
    }),
  )

  it.scoped('releases a refused repair identity when its queued retry is cancelled', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-retry-cancelled-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [issue])
      const refuseRepairDispatch = armFirstRepairDispatchRefusal(harness)
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.sync(() => {
              refuseRepairDispatch()
              return repairObservation(number, head)
            }),
        }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          expect(current.handoffs[0]?.repairStartedHeadSha).toBe(head)
          yield* control.setIssuePaused(20, true)
          return yield* control.snapshot
        }),
      )

      expect(snapshot.retrying).toEqual([])
      expect(snapshot.handoffs[0]?.repairStartedHeadSha).toBeNull()
    }),
  )

  it.scoped('attributes a repair head when its continuation becomes unroutable', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-unroutable-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const originalHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const repairedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      let currentIssue = issue
      let currentHead = originalHead
      yield* saveRepairHandoff(handoffStorePath, issue, originalHead)
      const harness = makeHarness(isolated, () => [currentIssue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, currentHead)),
        }),
        runAgent: () =>
          Effect.sync(() => {
            currentHead = repairedHead
          }).pipe(
            Effect.zipRight(
              Effect.fail(
                new AgentError({ category: 'process_exited', message: 'repair worker failed' }),
              ),
            ),
          ),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          currentIssue = { ...issue, labels: ['sloppenheimer'] }
          yield* TestClock.adjust('20 seconds')
          while (current.retrying.length !== 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          return current
        }),
      )

      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 1,
        repairHeadShas: [repairedHead],
        repairObservedHeadShas: [originalHead, repairedHead],
        repairStartedHeadSha: null,
      })
    }),
  )

  it.scoped('attributes a pushed head before dispatching a queued repair retry', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-retry-attributed-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const originalHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const intermediateHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      let currentHead = originalHead
      yield* saveRepairHandoff(handoffStorePath, issue, originalHead)
      const harness = makeHarness(isolated, () => [issue])
      const launchedDescriptions: (string | null)[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, currentHead)),
        }),
        // The first repair pushes a head and then fails; the second is held open so the state it
        // was dispatched with can be read.
        runAgent: ({ issue: launchedIssue }) =>
          Effect.suspend(() => {
            launchedDescriptions.push(launchedIssue.description)
            if (launchedDescriptions.length > 1) {
              return Effect.never
            }
            currentHead = intermediateHead
            return Effect.fail(
              new AgentError({ category: 'process_exited', message: 'repair worker failed' }),
            )
          }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // The failed attempt still owns the baseline it started from.
          expect(current.handoffs[0]?.repairStartedHeadSha).toBe(originalHead)
          yield* TestClock.adjust('30 seconds')
          while (current.handoffs[0]?.repairAttempts !== 1) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // The head it pushed has no review of its own yet, so the retry stands down rather than
          // repairing it blind -- but the head is already counted before it does.
          expect(current.handoffs[0]).toMatchObject({
            repairAttempts: 1,
            repairHeadShas: [intermediateHead],
            repairObservedHeadShas: [originalHead, intermediateHead],
          })
          // Reconciliation picks the head up, settles its review, and repairs it from there, so
          // standing down defers the work rather than stranding it.
          while (launchedDescriptions.length < 2) {
            yield* control.refresh
            yield* Effect.yieldNow()
          }
          current = yield* control.snapshot
          yield* control.setIssuePaused(20, true)
          return current
        }),
      )

      expect(launchedDescriptions[1]).toContain('## Pull request repair')
      expect(launchedDescriptions[1]).toContain(`Head: ${intermediateHead}`)
      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 1,
        repairHeadShas: [intermediateHead],
        repairStartedHeadSha: intermediateHead,
      })
    }),
  )

  it.scoped('advances the execution attempt when a repair retry fails again', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-retry-attempt-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [issue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        runAgent: () =>
          Effect.fail(
            new AgentError({ category: 'process_exited', message: 'repair worker failed' }),
          ),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying[0]?.attempt !== 2) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          yield* TestClock.adjust('20 seconds')
          while (current.retrying[0]?.attempt !== 3) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          return current
        }),
      )

      expect(snapshot.retrying[0]).toMatchObject({ issueId: issue.id, attempt: 3 })
      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 0,
        repairStartedHeadSha: head,
      })
      expect(yield* loadHandoffs(handoffStorePath)).toEqual([
        expect.objectContaining({ repairStartedHeadSha: head, repairWorkerStarted: true }),
      ])
    }),
  )

  it.scoped('admits a repair retry against the workflow it will be dispatched under', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-admission-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = {
        ...workflow,
        fingerprint: 'original',
        config: { ...workflow.config, workspaceRoot },
      }
      // The reload admits nothing. The handoff captured the workflow above, which admits one, and
      // that is the one the retry is dispatched under.
      const reloaded: Workflow = {
        ...isolated,
        fingerprint: 'reloaded',
        config: {
          ...isolated.config,
          agent: { ...isolated.config.agent, maxConcurrentAgents: 0 },
          tracker: { ...isolated.config.tracker, requiredLabels: ['new-policy'] },
        },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      let launches = 0
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [issue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        // The first repair fails without pushing, queueing a retry; the second is held open.
        runAgent: () =>
          Effect.suspend(() => {
            launches += 1
            return launches > 1
              ? Effect.never
              : Effect.fail(
                  new AgentError({ category: 'process_exited', message: 'repair worker failed' }),
                )
          }),
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // Live admission and eligibility both reject the issue while the repair retry is queued.
          // The captured handoff workflow still permits it and is the one that will run it.
          harness.setWorkflow(reloaded)
          harness.notifyChanged()
          while (current.effectiveWorkflow.fingerprint !== 'reloaded') {
            yield* control.refresh
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          yield* TestClock.adjust('30 seconds')
          while (launches < 2) {
            yield* Effect.yieldNow()
          }
          yield* control.setIssuePaused(20, true)
        }),
      )

      expect(launches).toBe(2)
    }),
  )

  it.scoped('dispatches a repair retry against the tracker record it just refetched', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-refetched-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const launched: Issue[] = []
      let currentIssue = issue
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [currentIssue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        // The first repair fails without pushing, queueing a retry; the second is held open.
        runAgent: ({ issue: launchedIssue }) =>
          Effect.suspend(() => {
            launched.push(launchedIssue)
            return launched.length > 1
              ? Effect.never
              : Effect.fail(
                  new AgentError({ category: 'process_exited', message: 'repair worker failed' }),
                )
          }),
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // The tracker record moves on while the repair retry waits: still active and routable,
          // but re-titled and re-prioritised.
          currentIssue = {
            ...issue,
            title: 'renamed upstream',
            description: 'new repair requirements from the tracker',
            priority: 5,
          }
          yield* TestClock.adjust('30 seconds')
          while (launched.length < 2) {
            yield* Effect.yieldNow()
          }
          yield* control.setIssuePaused(20, true)
        }),
      )

      // The retry carries the repair instructions on top of the record as it stands now, not the one
      // the handoff captured before any of this.
      expect(launched[1]?.title).toBe('renamed upstream')
      expect(launched[1]?.priority).toBe(5)
      expect(launched[1]?.description).toContain('new repair requirements from the tracker')
      expect(launched[1]?.description).toContain('## Pull request repair')
    }),
  )

  it.scoped('preserves a repair execution attempt across capacity deferral', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-retry-no-slot-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const repaired = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const occupier = {
        ...makeIssue('example/sloppenheimer#21', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('21'),
      }
      // Unchanged throughout, and already review-settled, so the review gate passes and the capacity
      // gate is what the retry actually meets.
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      let candidates: readonly Issue[] = [repaired]
      yield* saveRepairHandoff(handoffStorePath, repaired, head)
      const harness = makeHarness(isolated, () => candidates)
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        // The repair fails without pushing; the issue that takes the freed slot holds it.
        runAgent: ({ issue: launchedIssue }) =>
          Effect.suspend(() =>
            launchedIssue.id === repaired.id
              ? Effect.fail(
                  new AgentError({ category: 'process_exited', message: 'repair worker failed' }),
                )
              : Effect.never,
          ),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // The only agent slot is taken before the queued repair retry comes due.
          candidates = [repaired, occupier]
          while (current.running.length === 0) {
            yield* control.refresh
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          yield* TestClock.adjust('30 seconds')
          while (
            !current.retrying.some(
              (entry) =>
                entry.issueId === repaired.id &&
                entry.attempt === 2 &&
                entry.error === 'no available orchestrator slots',
            )
          ) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          yield* control.setIssuePaused(21, true)
          yield* TestClock.adjust('20 seconds')
          while (current.retrying[0]?.attempt !== 3) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          return current
        }),
      )

      // Waiting for capacity does not turn execution attempt 2 back into repair-budget attempt 1.
      // Once the slot opens, the failed worker advances the execution retry to attempt 3.
      expect(snapshot.retrying[0]).toMatchObject({ issueId: repaired.id, attempt: 3 })
      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 0,
        repairStartedHeadSha: head,
      })
    }),
  )

  it.scoped('attributes a repair head when its issue leaves the active states mid-run', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-inactive-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const originalHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const repairedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      let currentIssue = issue
      let currentHead = originalHead
      yield* saveRepairHandoff(handoffStorePath, issue, originalHead)
      const harness = makeHarness(isolated, () => [currentIssue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, currentHead)),
        }),
        // The repair pushes and then stays open, so only the cancellation ends it.
        runAgent: () =>
          Effect.sync(() => {
            currentHead = repairedHead
          }).pipe(Effect.zipRight(Effect.never)),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.running.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // Not terminal: the issue simply leaves its active states while its repair is running.
          currentIssue = { ...issue, state: 'blocked' }
          while (current.handoffs[0]?.repairAttempts !== 1) {
            yield* control.refresh
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          return current
        }),
      )

      expect(snapshot.running).toEqual([])
      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 1,
        repairHeadShas: [repairedHead],
        repairObservedHeadShas: [originalHead, repairedHead],
        repairStartedHeadSha: null,
      })
    }),
  )

  it.scoped('dispatches a repair retry through the workflow its handoff was captured under', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-reload-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = {
        ...workflow,
        fingerprint: 'original',
        promptTemplate: '{{ issue.description }}',
        config: { ...workflow.config, workspaceRoot },
      }
      // A reload that renders nothing of the issue would drop the repair instructions entirely.
      const reloaded: Workflow = {
        ...isolated,
        fingerprint: 'reloaded',
        promptTemplate: 'a reloaded template that says nothing about the pull request',
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [issue])
      const refuseRepairDispatch = armFirstRepairDispatchRefusal(harness)
      const launchedPrompts: string[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.sync(() => {
              refuseRepairDispatch()
              return repairObservation(number, head)
            }),
        }),
        runAgent: ({ prompt }) =>
          Effect.suspend(() => {
            launchedPrompts.push(prompt)
            return Effect.never
          }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // The workflow is reloaded and adopted while the refused repair waits to retry.
          harness.setWorkflow(reloaded)
          harness.notifyChanged()
          while (current.effectiveWorkflow.fingerprint !== 'reloaded') {
            yield* control.refresh
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          yield* TestClock.adjust('30 seconds')
          while (launchedPrompts.length === 0) {
            yield* Effect.yieldNow()
          }
          current = yield* control.snapshot
          yield* control.setIssuePaused(20, true)
          return current
        }),
      )

      expect(snapshot.effectiveWorkflow.fingerprint).toBe('reloaded')
      expect(launchedPrompts[0]).toContain('## Pull request repair')
      expect(launchedPrompts[0]).not.toContain('a reloaded template')
    }),
  )

  it.scoped('cleans up a terminal repair retry in the workspace its repair ran in', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-cleanup-')
      const reloadedRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-cleanup-reloaded-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = {
        ...workflow,
        fingerprint: 'original',
        config: { ...workflow.config, workspaceRoot },
      }
      // The reload moves the workspace root, so the two managers are told apart by where they clean.
      const reloaded: Workflow = {
        ...isolated,
        fingerprint: 'reloaded',
        config: { ...isolated.config, workspaceRoot: reloadedRoot },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      let currentIssue = issue
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [currentIssue])
      const refuseRepairDispatch = armFirstRepairDispatchRefusal(harness)
      const removedFrom: string[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.sync(() => {
              refuseRepairDispatch()
              return repairObservation(number, head)
            }),
        }),
        makeWorkspaces: (settings) => ({
          ...harness.ports.makeWorkspaces(settings),
          remove: () =>
            Effect.sync(() => {
              removedFrom.push(settings.root)
            }),
        }),
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          // The repair dispatch is refused, so its retry waits with the repair identity held.
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          harness.setWorkflow(reloaded)
          harness.notifyChanged()
          while (current.effectiveWorkflow.fingerprint !== 'reloaded') {
            yield* control.refresh
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // The issue closes before the retry comes due. Twenty seconds reaches the retry without
          // reaching the next poll, whose own terminal sweep cleans through the current manager.
          currentIssue = { ...issue, state: 'closed' }
          yield* TestClock.adjust('20 seconds')
          while (removedFrom.length === 0) {
            yield* Effect.yieldNow()
          }
        }),
      )

      expect(removedFrom[0]).toBe(workspaceRoot)
    }),
  )

  it.scoped('does not dispatch a fresh repair once a repair retry finds its issue terminal', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-terminal-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      let currentIssue = issue
      let launches = 0
      let workspacesCreated = 0
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [currentIssue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        makeWorkspaces: (settings) => ({
          ...harness.ports.makeWorkspaces(settings),
          withLeasedWorkspace: (_run, use) =>
            Effect.sync(() => {
              workspacesCreated += 1
            }).pipe(Effect.zipRight(use({ path: '/tmp/sloppenheimer-test', key: 'test' }))),
        }),
        // The repair pushes nothing and fails, so a retry is queued behind it.
        runAgent: () =>
          Effect.suspend(() => {
            launches += 1
            return Effect.fail(
              new AgentError({ category: 'process_exited', message: 'repair worker failed' }),
            )
          }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // The issue closes while the repair retry is queued, so the retry stands down.
          currentIssue = { ...issue, state: 'closed' }
          yield* TestClock.adjust('20 seconds')
          while (current.retrying.length !== 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          yield* control.refresh
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      // Nothing ran after the issue became terminal, so the unchanged head is not reported as a
      // no-op repair. The handoff remains observable, but new agent work is paused.
      expect(launches).toBe(1)
      expect(workspacesCreated).toBe(1)
      expect(snapshot.handoffs[0]).toMatchObject({
        state: 'repair_needed',
        repairAttempts: 0,
        repairStartedHeadSha: null,
        reason: 'Repair paused because the issue is terminal.',
      })
    }),
  )

  it.scoped('does not dispatch repairs for an idle handoff whose issue is no longer eligible', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-ineligible-handoff-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const handedOffIssue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const currentIssue = { ...handedOffIssue, labels: ['sloppenheimer'] }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      let launches = 0
      yield* saveRepairHandoff(handoffStorePath, handedOffIssue, head)
      const harness = makeHarness(isolated, () => [currentIssue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        runAgent: () =>
          Effect.sync(() => {
            launches += 1
          }).pipe(Effect.zipRight(Effect.never)),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (
            current.handoffs[0]?.reason !==
            'Repair paused because the issue is not eligible under its handoff workflow.'
          ) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          yield* control.refresh
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      expect(launches).toBe(0)
      expect(snapshot.running).toEqual([])
      expect(snapshot.retrying).toEqual([])
      expect(snapshot.handoffs[0]).toMatchObject({
        state: 'repair_needed',
        repairAttempts: 0,
        repairStartedHeadSha: null,
        reason: 'Repair paused because the issue is not eligible under its handoff workflow.',
      })
    }),
  )

  it.scoped('does not dispatch a fresh repair once a running repair finds its issue terminal', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-terminal-run-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      let currentIssue = issue
      let launches = 0
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [currentIssue])
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, head)),
        }),
        // The repair pushes nothing and stays open, so only the cancellation ends it.
        runAgent: () =>
          Effect.suspend(() => {
            launches += 1
            return Effect.never
          }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.running.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // The issue closes while its repair is running, so reconciliation cancels the worker.
          currentIssue = { ...issue, state: 'closed' }
          while (current.running.length !== 0) {
            yield* control.refresh
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          yield* control.refresh
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      // The cancelled worker's baseline is left standing, so the next inspection reaches the verdict
      // for a repair that changed nothing rather than starting another one.
      expect(launches).toBe(1)
      expect(snapshot.handoffs[0]).toMatchObject({
        state: 'intervention_required',
        repairAttempts: 0,
      })
    }),
  )

  it.scoped('attributes a repair head when the tracker omits the issue mid-run', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-missing-run-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const originalHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const repairedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      let candidates: readonly Issue[] = [issue]
      let currentHead = originalHead
      yield* saveRepairHandoff(handoffStorePath, issue, originalHead)
      const harness = makeHarness(isolated, () => candidates)
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, currentHead)),
        }),
        // The repair pushes and then stays open, so only the cancellation ends it.
        runAgent: () =>
          Effect.sync(() => {
            currentHead = repairedHead
          }).pipe(Effect.zipRight(Effect.never)),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.running.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // The tracker stops reporting the issue while its repair is running. The handoff stays
          // active, so the head that worker pushed is still the repair's.
          candidates = []
          while (current.handoffs[0]?.repairAttempts !== 1) {
            yield* control.refresh
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          return current
        }),
      )

      expect(snapshot.running).toEqual([])
      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 1,
        repairHeadShas: [repairedHead],
        repairObservedHeadShas: [originalHead, repairedHead],
        repairStartedHeadSha: null,
      })
    }),
  )

  it.scoped('attributes a repair head when the tracker omits the issue from a retry refresh', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-missing-issue-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const originalHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const repairedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      let currentHead = originalHead
      let candidates: readonly Issue[] = [issue]
      yield* saveRepairHandoff(handoffStorePath, issue, originalHead)
      const harness = makeHarness(isolated, () => candidates)
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, currentHead)),
        }),
        runAgent: () =>
          Effect.sync(() => {
            currentHead = repairedHead
          }).pipe(
            Effect.zipRight(
              Effect.fail(
                new AgentError({ category: 'process_exited', message: 'repair worker failed' }),
              ),
            ),
          ),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // The tracker stops reporting the issue before the queued retry comes due. The handoff
          // stays active, so the head the failed worker pushed is still the repair's.
          candidates = []
          yield* TestClock.adjust('20 seconds')
          while (current.retrying.length !== 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          while (current.handoffs[0]?.repairAttempts !== 1) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          return current
        }),
      )

      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 1,
        repairHeadShas: [repairedHead],
        repairObservedHeadShas: [originalHead, repairedHead],
        repairStartedHeadSha: null,
      })
    }),
  )

  it.scoped('records that a refused repair dispatch never started a worker', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-refused-record-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [issue])
      const refuseRepairDispatch = armFirstRepairDispatchRefusal(harness)
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.sync(() => {
              refuseRepairDispatch()
              return repairObservation(number, head)
            }),
        }),
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // A pass that skips this handoff, because its retry is queued, still writes the store.
          yield* control.refresh
          expect(current.handoffs[0]?.repairStartedHeadSha).toBe(head)
        }),
      )

      expect(yield* loadHandoffs(handoffStorePath)).toEqual([
        expect.objectContaining({ repairStartedHeadSha: head, repairWorkerStarted: false }),
      ])
    }),
  )

  it.scoped('does not escalate a refused repair when its issue becomes terminal before retry', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-refused-terminal-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      let currentIssue = issue
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [currentIssue])
      const refuseRepairDispatch = armFirstRepairDispatchRefusal(harness)
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.sync(() => {
              refuseRepairDispatch()
              return repairObservation(number, head)
            }),
        }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          currentIssue = { ...issue, state: 'closed' }
          yield* TestClock.adjust('20 seconds')
          while (current.retrying.length !== 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          return current
        }),
      )

      expect(snapshot.handoffs[0]).toMatchObject({
        state: 'repair_needed',
        repairAttempts: 0,
        repairStartedHeadSha: null,
        repairWorkerStarted: false,
        reason: 'Repair paused because the issue is terminal.',
      })
    }),
  )

  it.scoped('settles a refused repair when tracker policy rejects its refresh retry', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-refused-refresh-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      let rejectRefresh = false
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [issue])
      const refuseRepairDispatch = armFirstRepairDispatchRefusal(harness)
      const ports: TestPorts = {
        ...harness.ports,
        makeTracker: (provider) => {
          const tracker = harness.ports.makeTracker(provider)
          return {
            ...tracker,
            fetchIssuesByIds: (ids) =>
              rejectRefresh
                ? Effect.fail(
                    new TrackerError({
                      category: 'tracker_response',
                      message: 'retry refresh was rejected',
                      retryable: false,
                    }),
                  )
                : tracker.fetchIssuesByIds(ids),
          }
        },
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.sync(() => {
              refuseRepairDispatch()
              return repairObservation(number, head)
            }),
        }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          expect(current.handoffs[0]).toMatchObject({
            repairStartedHeadSha: head,
            repairWorkerStarted: false,
          })
          rejectRefresh = true
          yield* TestClock.adjust('20 seconds')
          while (current.retrying.length !== 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          // A retained handoff remains the scheduler's claim even though retry policy rejected
          // another attempt. The ordinary candidate pass must not redispatch it without the repair
          // prompt and lifecycle.
          yield* control.refresh
          current = yield* control.snapshot
          return current
        }),
      )

      expect(snapshot.handoffs[0]).toMatchObject({
        state: 'repair_needed',
        repairAttempts: 0,
        repairStartedHeadSha: null,
        repairWorkerStarted: false,
      })
      expect(snapshot.retrying).toEqual([])
      expect(yield* loadHandoffs(handoffStorePath)).toEqual([
        expect.objectContaining({ repairStartedHeadSha: null, repairWorkerStarted: false }),
      ])
    }),
  )

  it.scoped('settles a refused repair when tracker policy rejects its baseline inspection', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-refused-inspection-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      let rejectInspection = false
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const harness = makeHarness(isolated, () => [issue])
      const refuseRepairDispatch = armFirstRepairDispatchRefusal(harness)
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            rejectInspection
              ? Effect.fail(
                  new TrackerError({
                    category: 'tracker_response',
                    message: 'baseline inspection was rejected',
                    retryable: false,
                  }),
                )
              : Effect.sync(() => {
                  refuseRepairDispatch()
                  return repairObservation(number, head)
                }),
        }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          rejectInspection = true
          yield* TestClock.adjust('20 seconds')
          while (current.retrying.length !== 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      expect(snapshot.handoffs[0]).toMatchObject({
        state: 'repair_needed',
        repairAttempts: 0,
        repairStartedHeadSha: null,
        repairWorkerStarted: false,
      })
      expect(snapshot.retrying).toEqual([])
      expect(yield* loadHandoffs(handoffStorePath)).toEqual([
        expect.objectContaining({ repairStartedHeadSha: null, repairWorkerStarted: false }),
      ])
    }),
  )

  it.scoped('does not attribute a manual head to a restored repair that never ran', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-repair-restored-refused-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const originalHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const manualHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      yield* saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
          branchName: 'sloppenheimer/issue-20',
          state: 'repair_needed',
          headSha: originalHead,
          reason: 'The pull request conflicts with protected main',
          repairAttempts: 0,
          repairHeadShas: [],
          repairObservedHeadShas: [originalHead],
          repairStartedHeadSha: originalHead,
          repairWorkerStarted: false,
          reviewRequestedHeadSha: manualHead,
          reviewCompletedHeadSha: manualHead,
          observedAt: new Date(0).toISOString(),
        },
      ])
      const harness = makeHarness(isolated, () => [issue])
      const launchedDescriptions: (string | null)[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) => Effect.succeed(repairObservation(number, manualHead)),
        }),
        runAgent: ({ issue: launchedIssue }) =>
          Effect.suspend(() => {
            launchedDescriptions.push(launchedIssue.description)
            return Effect.never
          }),
      }

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          while (launchedDescriptions.length === 0) {
            yield* Effect.yieldNow()
          }
          const current = yield* control.snapshot
          yield* control.setIssuePaused(20, true)
          return current
        }),
      )

      // The head moved while no worker was running, so it is a manual push rather than repair
      // output: the budget is untouched and the fresh repair baselines on what is there now.
      expect(launchedDescriptions[0]).toContain(`Head: ${manualHead}`)
      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 0,
        repairHeadShas: [],
        repairStartedHeadSha: manualHead,
      })
    }),
  )

  it.scoped('keeps observing a handoff that needs intervention', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-intervention-observed-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
        dispatchable: false,
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveHandoffs(handoffStorePath, [
        {
          issueId: issue.id,
          identifier: issue.identifier,
          pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
          branchName: 'sloppenheimer/issue-20',
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
      ])
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
                    url: 'https://github.test/example/sloppenheimer/pull/65',
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
                    url: 'https://github.test/example/sloppenheimer/pull/65',
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

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          // Two observations: the first finds it still open and unrepaired, the second finds the
          // operator's manual merge.
          yield* control.refresh
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      // The intervention state suppressed further repairs but never stopped observation, so the
      // manual merge was seen and the handoff no longer holds the issue.
      expect(inspections).toBeGreaterThan(1)
      expect(snapshot.handoffs).toEqual([])
    }),
  )

  it.scoped('does not turn a continuation retry into a pull request repair', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-retry-isolation-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
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
                ? ({ _tag: 'NoBranch', branchName: 'sloppenheimer/issue-20' } as const)
                : ({
                    _tag: 'PullRequest',
                    branchName: 'sloppenheimer/issue-20',
                    pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
                    pullRequestNumber: 65,
                    created: true,
                  } as const)
            }),
          inspectPullRequest: (number) =>
            Effect.succeed({
              number,
              state: 'open' as const,
              url: 'https://github.test/example/sloppenheimer/pull/65',
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

      const snapshot = yield* Effect.scoped(
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
      )

      expect(handoffCalls).toBe(2)
      expect(snapshot.handoffs[0]).toMatchObject({
        repairAttempts: 0,
        repairHeadShas: [],
        repairStartedHeadSha: null,
      })
    }),
  )
})

describe('persisted finished work', (): void => {
  /** The instant every test in this block dates its finished work against. */
  const now = Date.parse('2026-08-31T12:00:00.000Z')

  const awaitingChecks = (issue: Issue): HandoffSnapshot => ({
    issueId: issue.id,
    identifier: issue.identifier,
    pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/44',
    branchName: 'sloppenheimer/issue-63',
    state: 'awaiting_checks',
    headSha: null,
    reason: null,
    repairAttempts: 0,
    observedAt: new Date(now).toISOString(),
  })

  /** A code review that reports the pull request as already merged, at the instant given. */
  const mergedAt =
    (harness: TestHarness, instant: string) =>
    (provider: ValidatedTrackerProvider): CodeReviewPort => ({
      ...requireCodeReview(harness.ports, provider),
      inspectPullRequest: (pullRequestNumber) =>
        Effect.succeed({
          number: pullRequestNumber,
          state: 'closed' as const,
          url: null,
          headSha: null,
          merged: true as const,
          mergeCommitSha: null,
          mergedAt: instant,
          mergeable: null,
          mergeState: 'unknown',
          checks: [],
          reviewDecision: null,
          reviewThreads: [],
        }),
    })

  const completion = (identifier: string, finishedAt: string): CompletedSnapshot => ({
    issueId: issueId(identifier),
    identifier,
    title: identifier,
    url: null,
    outcome: 'merged',
    finishedAt,
    pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/9',
  })

  it.scoped('carries finished work across a restart, dated by the provider merge time', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-completion-store-')
      const completionStorePath = join(workspaceRoot, '.sloppenheimer', 'completions.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#63', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('63'),
      }
      yield* saveHandoffs(join(workspaceRoot, '.sloppenheimer', 'handoffs.json'), [
        awaitingChecks(issue),
      ])
      const merging = makeHarness(isolated, () => [issue])

      const before = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...merging.ports,
            makeCodeReview: mergedAt(merging, '2026-08-31T09:00:00.000Z'),
          })
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      // That host is gone. A second one comes up against the same workspace, and the tracker no
      // longer lists an issue whose pull request merged.
      const restarted = makeHarness(isolated)
      const after = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', restarted.ports)
          yield* control.refresh
          return {
            snapshot: yield* control.snapshot,
            detail: yield* control.agentDetail(issue.identifier),
          }
        }),
      )

      expect(before.completed).toHaveLength(1)
      expect(yield* loadCompletions(completionStorePath)).toEqual(before.completed)
      // The window is a window again rather than a lifetime: the restart no longer empties it.
      expect(after.snapshot.completed).toEqual(before.completed)
      expect(after.snapshot.completed[0]).toMatchObject({
        identifier: issue.identifier,
        outcome: 'merged',
        pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/44',
        finishedAt: '2026-08-31T09:00:00.000Z',
      })
      expect(after.snapshot.counts.completed).toBe(1)
      // The deliberate half of #172. A restored completion is republished history and nothing
      // more: it holds no claim and no session, so the versioned agent-detail resource answers
      // exactly as it did before this store existed.
      expect(after.detail).toEqual({ _tag: 'Unknown', identifier: issue.identifier })
    }),
  )

  it.scoped('writes both stores beside the workspace root a reload moved to', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-completion-reload-')
      const reloadedRoot = yield* isolatedWorkspaceRoot('sloppenheimer-completion-reloaded-')
      const isolated: Workflow = {
        ...workflow,
        fingerprint: 'original',
        config: { ...workflow.config, workspaceRoot },
      }
      // The reload moves the workspace root; the stores describe one host's state and must follow
      // it, or the next startup reads them from a directory this host never wrote to.
      const reloaded: Workflow = {
        ...isolated,
        fingerprint: 'reloaded',
        config: { ...isolated.config, workspaceRoot: reloadedRoot },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#63', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('63'),
      }
      yield* saveHandoffs(join(workspaceRoot, '.sloppenheimer', 'handoffs.json'), [
        awaitingChecks(issue),
      ])
      // The issue hydrates the restored handoff but is never offered for dispatch: this test is
      // about where the stores are written, not about putting an agent on the issue.
      const harness = makeHarness(
        isolated,
        () => [issue],
        () => Effect.succeed([]),
      )
      // The pull request stays unfinished until the reload has taken effect, so the merge this
      // asserts on is one the host records under the root it moved to.
      const openHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      let merged = false
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (pullRequestNumber) =>
            merged
              ? mergedAt(
                  harness,
                  '2026-08-31T09:00:00.000Z',
                )(provider).inspectPullRequest(pullRequestNumber)
              : Effect.succeed(
                  anOpenPullRequest({
                    number: pullRequestNumber,
                    headSha: openHead,
                    // Its review is already in hand and its checks have not finished, so the
                    // handoff sits at awaiting checks and calls nothing while the reload lands.
                    codexReview: { headShaPrefix: openHead.slice(0, 7), status: 'completed' },
                    checks: [
                      { name: 'quality', status: 'in_progress', conclusion: null, url: null },
                    ],
                  }),
                ),
        }),
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          harness.setWorkflow(reloaded)
          harness.notifyChanged()
          let current = yield* control.snapshot
          while (current.effectiveWorkflow.fingerprint !== 'reloaded') {
            yield* control.refresh
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          merged = true
          yield* control.refresh
        }),
      )

      expect(
        yield* loadCompletions(join(reloadedRoot, '.sloppenheimer', 'completions.json')),
      ).toMatchObject([{ identifier: issue.identifier, finishedAt: '2026-08-31T09:00:00.000Z' }])
      // The handoff store follows the same root: the merged handoff is gone from the store beside
      // the workspace this host is now using, not left recorded only beside the one it booted with.
      expect(yield* loadHandoffs(join(reloadedRoot, '.sloppenheimer', 'handoffs.json'))).toEqual([])
      expect(
        yield* loadCompletions(join(workspaceRoot, '.sloppenheimer', 'completions.json')),
      ).toEqual([])
    }),
  )

  it.scoped('restores only the finished work the console would still show', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-completion-window-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      yield* saveCompletions(join(workspaceRoot, '.sloppenheimer', 'completions.json'), [
        completion('example/sloppenheimer#70', new Date(now - 2 * 60 * 60 * 1000).toISOString()),
        completion(
          'example/sloppenheimer#71',
          new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
        ),
      ])
      const harness = makeHarness(isolated)

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      expect(snapshot.completed.map((entry) => entry.identifier)).toEqual([
        'example/sloppenheimer#70',
      ])
      expect(snapshot.counts.completed).toBe(1)
    }),
  )

  it.scoped('carries restored history to a moved root without waiting for a merge', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-completion-migrate-')
      const reloadedRoot = yield* isolatedWorkspaceRoot('sloppenheimer-completion-migrated-')
      const isolated: Workflow = {
        ...workflow,
        fingerprint: 'original',
        config: { ...workflow.config, workspaceRoot },
      }
      const reloaded: Workflow = {
        ...isolated,
        fingerprint: 'reloaded',
        config: { ...isolated.config, workspaceRoot: reloadedRoot },
      }
      const restored = completion(
        'example/sloppenheimer#70',
        new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      )
      yield* saveCompletions(join(workspaceRoot, '.sloppenheimer', 'completions.json'), [restored])
      const harness = makeHarness(isolated)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* control.refresh
          harness.setWorkflow(reloaded)
          harness.notifyChanged()
          let current = yield* control.snapshot
          while (current.effectiveWorkflow.fingerprint !== 'reloaded') {
            yield* control.refresh
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
        }),
      )

      // Nothing merged while this host ran, and nothing ever might: the move itself is what has to
      // carry the history across, or a restart under the new root loses it.
      expect(
        yield* loadCompletions(join(reloadedRoot, '.sloppenheimer', 'completions.json')),
      ).toEqual([restored])
    }),
  )

  it.scoped('starts without its history when the completion store cannot be read', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-completion-unreadable-')
      const completionStorePath = join(workspaceRoot, '.sloppenheimer', 'completions.json')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const issue = {
        ...makeIssue('example/sloppenheimer#63', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('63'),
      }
      yield* saveHandoffs(join(workspaceRoot, '.sloppenheimer', 'handoffs.json'), [
        awaitingChecks(issue),
      ])
      yield* Effect.promise(() => writeFile(completionStorePath, '{"version":1,"completions":['))
      const merging = makeHarness(isolated, () => [issue])

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...merging.ports,
            makeCodeReview: mergedAt(merging, '2026-08-31T09:00:00.000Z'),
          })
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      // Startup carried on, and this host's own merge is still reported.
      expect(snapshot.completed).toHaveLength(1)
      // The unreadable document is preserved rather than replaced, exactly as an unreadable
      // handoff store is: what it holds has not been read, so it must not be written over.
      expect(yield* Effect.promise(() => readFile(completionStorePath, 'utf8'))).toBe(
        '{"version":1,"completions":[',
      )
    }),
  )
})

describe('startup terminal workspace cleanup', (): void => {
  it.effect(
    'fetches every terminal state once, cleans every issue, and continues after a cleanup failure',
    () =>
      Effect.gen(function* () {
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
                return Effect.succeed(
                  terminalIssues.filter((issue) => states.includes(issue.state)),
                )
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

        yield* Effect.scoped(
          Effect.gen(function* () {
            const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
            yield* control.snapshot
            yield* control.refresh
            yield* control.snapshot
          }),
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
      }),
  )

  it.effect('continues startup and dispatch when the terminal fetch fails', () =>
    Effect.gen(function* () {
      const activeIssue = makeIssue('GH-4', 1, null, ['sloppenheimer', 'ready'])
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* harness.awaitAgentRun
        }),
      )

      expect(harness.agentRuns()).toHaveLength(1)
    }),
  )

  it.effect('preserves successful cleanup results when another terminal state fetch fails', () =>
    Effect.gen(function* () {
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.snapshot
        }),
      )

      expect(removed).toEqual(['GH-9'])
    }),
  )

  it.effect('does not dispatch until the startup sweep completes', () =>
    Effect.gen(function* () {
      const terminalIssue = { ...makeIssue('GH-5', null, null), state: 'closed' }
      const activeIssue = makeIssue('GH-6', 1, null, ['sloppenheimer', 'ready'])
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

      // Forked, not awaited: the case asserts what has and has not happened while the run is
      // still in flight, which is what the pending promise did before.
      const running = yield* Effect.fork(
        Effect.scoped(
          Effect.gen(function* () {
            yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
            yield* harness.awaitAgentRun
          }),
        ),
      )
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(resolve)
          }),
      )
      expect(harness.agentRuns()).toEqual([])

      resolveCleanup()
      yield* Fiber.join(running)
      expect(harness.agentRuns()).toHaveLength(1)
    }),
  )

  it.effect('preserves the workspace when an issue reopens during startup cleanup', () =>
    Effect.gen(function* () {
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.snapshot
        }),
      )

      expect(removed).toEqual([])
    }),
  )

  it.effect('does not refresh terminal issues without retained workspaces', () =>
    Effect.gen(function* () {
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.snapshot
        }),
      )

      expect(idFetches).toBe(0)
    }),
  )
})

const awaitLoads = (harness: TestHarness, expected: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (harness.loads() < expected) {
      yield* Effect.yieldNow()
    }
  })

describe('operator snapshots', (): void => {
  it.effect('start and remain responsive while the initial tracker poll is pending', () =>
    Effect.gen(function* () {
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

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* Effect.promise(() => pollStarted)
          return yield* control.snapshot
        }),
      )

      expect(snapshot.effectiveWorkflow.fingerprint).toBe('test')
    }),
  )

  it.effect('runs one follow-up poll for a refresh received during a pending poll', () =>
    Effect.gen(function* () {
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

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* control.refresh
          pollShouldBlock = true
          yield* Effect.forkScoped(control.refresh)
          yield* Effect.promise(() => pollStarted)
          harness.setWorkflow(reloaded)
          const lateRefresh = yield* Effect.forkScoped(control.refresh)
          // Let the request register against the running poll before the second one arrives, so
          // the two are asserted in the order they were made rather than in a scheduling order.
          yield* Effect.yieldNow()
          const laterRefresh = yield* Effect.forkScoped(control.refresh)
          yield* Effect.yieldNow()
          pollShouldBlock = false
          releasePoll()
          const outcome = yield* Fiber.join(lateRefresh)
          const later = yield* Fiber.join(laterRefresh)
          // The first request is what asked the running poll for a follow-up pass, so it created
          // work; the second only joined the pass the first had already arranged.
          expect(outcome.coalesced).toBe(false)
          expect(later.coalesced).toBe(true)
          expect(outcome.operations).toContain('dispatch')
          expect(Number.isNaN(Date.parse(outcome.requestedAt))).toBe(false)
          return yield* control.snapshot
        }),
      )

      expect(snapshot.effectiveWorkflow.fingerprint).toBe('late-refresh')
    }),
  )

  it.effect('preserves a refresh started while the previous refresh is settling', () =>
    Effect.gen(function* () {
      const harness = makeHarness(workflow)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* control.refresh
          const before = harness.stateFetches()
          const consecutiveRefreshes = yield* Effect.forkScoped(
            Effect.all([control.refresh, control.refresh]),
          )
          const [first, second] = yield* Fiber.join(consecutiveRefreshes)
          expect(harness.stateFetches()).toBe(before + 2)
          // Each request scheduled the pass it waited for, so neither was coalesced into the other.
          expect([first.coalesced, second.coalesced]).toEqual([false, false])
        }),
      )
    }),
  )
})

describe('workflow hot reload', (): void => {
  it.effect('replaces the last known good workflow after a valid defensive reload', () =>
    Effect.gen(function* () {
      const initial = changedWorkflow({ fingerprint: 'initial', pollingIntervalMs: 1_000 })
      const reloaded = changedWorkflow({
        fingerprint: 'reloaded',
        pollingIntervalMs: 5_000,
        maxConcurrentAgents: 4,
      })
      const harness = makeHarness(initial)

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* control.refresh
          harness.setWorkflow(reloaded)
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      expect(snapshot.effectiveWorkflow.fingerprint).toBe('reloaded')
      expect(snapshot.pollingIntervalMs).toBe(5_000)
      expect(snapshot.maxConcurrentAgents).toBe(4)
      expect(snapshot.workflowReloadError).toBeNull()
    }),
  )

  it.effect('refuses a reload that changes the runner kind and keeps the last known good', () =>
    Effect.gen(function* () {
      // There is no cell to replace the runner through: it is bound once, at startup, because it
      // holds no per-workflow state. Silently ignoring a changed kind would leave an operator
      // watching a workflow that says one thing while the host runs another, which is the class of
      // quiet failure this boundary exists to remove — so the reload is refused instead.
      const initial = changedWorkflow({ fingerprint: 'initial', pollingIntervalMs: 1_000 })
      const reloaded: Workflow = {
        ...changedWorkflow({ fingerprint: 'repointed', pollingIntervalMs: 5_000 }),
        runner: stubRunner('meridian'),
      }
      const harness = makeHarness(initial)

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* control.refresh
          harness.setWorkflow(reloaded)
          yield* control.refresh
          return yield* control.snapshot
        }),
      )

      expect(snapshot.effectiveWorkflow.fingerprint).toBe('initial')
      expect(snapshot.pollingIntervalMs).toBe(1_000)
      expect(snapshot.workflowReloadError?.message).toBe(
        'runner.kind changed from aurora to meridian; restart the host to select a different agent runner',
      )
    }),
  )

  it.effect('uses all reloaded settings for future operations', () =>
    Effect.gen(function* () {
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
          runner: { ...workflow.config.runner, command: 'reloaded-codex app-server' },
        },
      }
      const issue = makeIssue('GH-9', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(initial, (effective) =>
        effective.fingerprint === reloaded.fingerprint ? [issue] : [],
      )

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* control.refresh
          harness.setWorkflow(reloaded)
          yield* control.refresh
          const snapshot = yield* control.snapshot
          yield* harness.awaitAgentRun
          return snapshot
        }),
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
    }),
  )

  it.effect(
    'keeps invalid reloads visible while reconciling without fetching dispatch candidates',
    () =>
      Effect.gen(function* () {
        const runningIssue = makeIssue('GH-1', 1, null, ['sloppenheimer', 'ready'])
        const candidate = makeIssue('GH-2', 2, null, ['sloppenheimer', 'ready'])
        let candidates: readonly Issue[] = [runningIssue]
        const initial = changedWorkflow({ fingerprint: 'last-known-good' })
        const harness = makeHarness(initial, () => candidates)

        const observed = yield* Effect.scoped(
          Effect.gen(function* () {
            const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
            yield* control.refresh
            yield* harness.awaitAgentRun
            const candidateFetches = harness.stateFetches()
            const reconciliations = harness.idFetches()
            candidates = [runningIssue, candidate]
            harness.setWorkflow(
              new WorkflowError({ category: 'invalid_config', message: 'invalid reload' }),
            )
            const refreshed = yield* control.refresh
            return {
              snapshot: yield* control.snapshot,
              candidateFetches,
              reconciliations,
              refreshed,
            }
          }),
        )

        expect(observed.snapshot.effectiveWorkflow.fingerprint).toBe('last-known-good')
        expect(observed.snapshot.workflowReloadError?.message).toBe('invalid reload')
        expect(harness.idFetches()).toBeGreaterThan(observed.reconciliations)
        expect(harness.stateFetches()).toBe(observed.candidateFetches)
        expect(harness.agentRuns()).toHaveLength(1)
        expect(observed.snapshot.running[0]?.issueId).toBe(runningIssue.id)
        expect(observed.snapshot.retrying).toEqual([])
        // The pass stopped before dispatch, and the refresh acknowledgement says so rather than
        // reporting the stages a healthy pass would have reached.
        expect(observed.refreshed.operations).toEqual([
          'credential_revalidation',
          'handoff_recovery',
          'workflow_reload',
          'handoff_reconciliation',
          'issue_reconciliation',
        ])
      }),
  )

  it.effect(
    'publishes a credential validation failure without fetching or claiming candidates',
    () =>
      Effect.gen(function* () {
        const candidate = makeIssue('GH-1', 1, null, ['sloppenheimer', 'ready'])
        const environment: Record<string, string> = { SLOPPENHEIMER_TEST_TOKEN: 'secret' }
        let candidates: readonly Issue[] = []
        const initial = changedWorkflow({ fingerprint: 'last-known-good' })
        const harness = makeHarness(initial, () => candidates, undefined, environment)

        const observed = yield* Effect.scoped(
          Effect.gen(function* () {
            const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
            yield* control.refresh
            const candidateFetches = harness.stateFetches()
            candidates = [candidate]
            delete environment['SLOPPENHEIMER_TEST_TOKEN']
            yield* control.refresh
            const failedSnapshot = yield* control.snapshot
            const agentRunsAfterFailure = harness.agentRuns().length
            environment['SLOPPENHEIMER_TEST_TOKEN'] = 'restored'
            yield* control.refresh
            return {
              failedSnapshot,
              recoveredSnapshot: yield* control.snapshot,
              candidateFetches,
              agentRunsAfterFailure,
            }
          }),
        )

        expect(observed.failedSnapshot.effectiveWorkflow.fingerprint).toBe('last-known-good')
        expect(observed.failedSnapshot.workflowReloadError?.message).toContain(
          'references a missing environment variable',
        )
        expect(observed.agentRunsAfterFailure).toBe(0)
        expect(observed.failedSnapshot.running).toEqual([])
        expect(observed.failedSnapshot.retrying).toEqual([])
        expect(observed.recoveredSnapshot.workflowReloadError).toBeNull()
        expect(harness.stateFetches()).toBe(observed.candidateFetches + 1)
        expect(harness.agentRuns()).toHaveLength(1)
      }),
  )

  it.effect('defers stalled-worker retry creation until validation recovers', () =>
    Effect.gen(function* () {
      const issue = makeIssue('GH-1', 1, null, ['sloppenheimer', 'ready'])
      const initial: Workflow = {
        ...changedWorkflow({ fingerprint: 'last-known-good' }),
        config: {
          ...workflow.config,
          runner: { ...workflow.config.runner, stallTimeoutMs: 1 },
        },
      }
      const harness = makeHarness(initial, () => [issue])

      const observed = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* harness.awaitAgentRun
          yield* TestClock.adjust(2)
          harness.setWorkflow(
            new WorkflowError({ category: 'invalid_config', message: 'invalid reload' }),
          )
          yield* control.refresh
          const failedSnapshot = yield* control.snapshot
          harness.setWorkflow(initial)
          yield* control.refresh
          return { failedSnapshot, recoveredSnapshot: yield* control.snapshot }
        }),
      )

      expect(observed.failedSnapshot.workflowReloadError?.message).toBe('invalid reload')
      expect(observed.failedSnapshot.running[0]?.issueId).toBe(issue.id)
      expect(observed.failedSnapshot.retrying).toEqual([])
      expect(observed.recoveredSnapshot.running).toEqual([])
      expect(observed.recoveredSnapshot.retrying[0]).toMatchObject({
        issueId: issue.id,
        attempt: 1,
        error: 'agent stalled',
      })
    }),
  )

  it.scoped('reconciles a repair handoff without dispatching it during a failed tick', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-invalid-repair-tick-')
      const handoffStorePath = join(workspaceRoot, '.sloppenheimer', 'handoffs.json')
      const initial: Workflow = {
        ...changedWorkflow({ fingerprint: 'last-known-good' }),
        config: { ...workflow.config, workspaceRoot },
      }
      const issue = {
        ...makeIssue('example/sloppenheimer#20', 1, null, ['sloppenheimer', 'ready']),
        id: issueId('20'),
      }
      const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      yield* saveRepairHandoff(handoffStorePath, issue, head)
      const environment: Record<string, string> = { SLOPPENHEIMER_TEST_TOKEN: 'secret' }
      const harness = makeHarness(initial, () => [issue], undefined, environment)
      let repairReady = false
      let inspections = 0
      let launches = 0
      let candidatePasses = 0
      const ports: TestPorts = {
        ...harness.ports,
        makeTracker: (provider) => {
          const tracker = harness.ports.makeTracker(provider)
          return {
            ...tracker,
            fetchIssuesByStates: () =>
              Effect.sync(() => {
                candidatePasses += 1
                return []
              }),
          }
        },
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          inspectPullRequest: (number) =>
            Effect.sync(() => {
              inspections += 1
              const observation = repairObservation(number, head)
              return repairReady
                ? observation
                : { ...observation, mergeable: null, mergeState: 'unknown' }
            }),
        }),
        runAgent: () =>
          Effect.sync(() => {
            launches += 1
          }).pipe(Effect.zipRight(Effect.never)),
      }

      const observed = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          const candidatePassesBeforeFailure = candidatePasses
          const inspectionsBeforeFailure = inspections
          repairReady = true
          delete environment['SLOPPENHEIMER_TEST_TOKEN']
          yield* control.refresh
          const failedSnapshot = yield* control.snapshot
          const launchesAfterFailure = launches
          environment['SLOPPENHEIMER_TEST_TOKEN'] = 'restored'
          yield* control.refresh
          return {
            failedSnapshot,
            recoveredSnapshot: yield* control.snapshot,
            candidatePassesBeforeFailure,
            inspectionsBeforeFailure,
            launchesAfterFailure,
          }
        }),
      )

      expect(inspections).toBeGreaterThan(observed.inspectionsBeforeFailure)
      expect(observed.launchesAfterFailure).toBe(0)
      expect(observed.failedSnapshot.retrying).toEqual([])
      expect(observed.failedSnapshot.handoffs[0]).toMatchObject({
        state: 'repair_needed',
        repairStartedHeadSha: null,
      })
      expect(candidatePasses).toBe(observed.candidatePassesBeforeFailure + 1)
      expect(launches).toBe(1)
      expect(observed.recoveredSnapshot.running[0]?.issueId).toBe(issue.id)
    }),
  )

  it.effect('defensively reloads after a missed watch event', () =>
    Effect.gen(function* () {
      const initial = changedWorkflow({ fingerprint: 'initial', pollingIntervalMs: 1_000 })
      const harness = makeHarness(initial)

      const snapshot = yield* Effect.scoped(
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
      )

      expect(snapshot.effectiveWorkflow.fingerprint).toBe('missed-event')
    }),
  )

  it.effect('re-arms future ticks with a changed polling interval', () =>
    Effect.gen(function* () {
      const initial = changedWorkflow({ fingerprint: 'initial', pollingIntervalMs: 1_000 })
      const harness = makeHarness(initial)

      yield* Effect.scoped(
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
      )
    }),
  )

  it.effect('coalesces watcher and defensive reload requests', () =>
    Effect.gen(function* () {
      const harness = makeHarness(changedWorkflow({ fingerprint: 'initial' }))

      yield* Effect.scoped(
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
      )
    }),
  )

  it.effect('reloads the workflow when the watcher reports a change', () =>
    Effect.gen(function* () {
      const harness = makeHarness(changedWorkflow({ fingerprint: 'initial' }))

      const fingerprint = yield* Effect.scoped(
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
      )

      expect(fingerprint).toBe('watched')
    }),
  )

  it.effect('installs the workflow watcher before startup returns', () =>
    Effect.gen(function* () {
      const harness = makeHarness(changedWorkflow({ fingerprint: 'initial' }))
      let watchedPath: string | null = null
      const ports: TestPorts = {
        ...harness.ports,
        watchWorkflow: (path, onChange) => {
          watchedPath = path
          harness.ports.watchWorkflow(path, onChange)
        },
      }

      const observed = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          // Read before yielding: an edit made the instant startup returns has to find the watcher
          // already in place, not a subscription still waiting on a fiber to be scheduled.
          return watchedPath
        }),
      )

      expect(observed).toBe('/tmp/WORKFLOW.md')
    }),
  )

  it.effect('interrupts a watcher-triggered tick when the orchestrator shuts down', () =>
    Effect.gen(function* () {
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

      const loads = yield* Effect.gen(function* () {
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
      })

      expect(pollInterrupted).toBe(true)
      expect(watchReleased).toBe(true)
      expect(loads.afterShutdown).toBe(loads.atShutdown)
    }),
  )

  it.effect('uses the provider returned by dispatch preflight', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#1', 1, null, ['sloppenheimer', 'ready'])
      const environment: Record<string, string> = { SLOPPENHEIMER_TEST_TOKEN: 'secret' }
      const harness = makeHarness(
        workflow,
        () => [],
        () => {
          environment['SLOPPENHEIMER_TEST_TOKEN'] = 'rotated'
          return Effect.succeed([issue])
        },
        environment,
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* harness.awaitAgentRun
        }),
      )

      const latest = harness.trackerProviders().map(githubProviderOf).at(-1)
      expect(latest === undefined ? null : Redacted.value(latest.token)).toBe('rotated')
    }),
  )

  it.effect('cancels a running worker when the operator explicitly pauses its issue', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#1', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(changedWorkflow({ fingerprint: 'initial' }), () => [issue])

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', harness.ports)
          yield* harness.awaitAgentRun
          yield* control.setIssuePaused(1, true)
          return yield* control.snapshot
        }),
      )

      expect(snapshot.counts.running).toBe(0)
    }),
  )
})

describe('per-run workspace leases', (): void => {
  /** Records what the orchestrator asked the workspace manager for, in the order it asked. */
  const recordingWorkspaces =
    (
      harness: TestHarness,
      acquired: Workspace[],
      released: Readonly<{ path: string; release: WorkspaceRelease }>[],
    ): TestPorts['makeWorkspaces'] =>
    (settings) => {
      const base = harness.ports.makeWorkspaces(settings)
      return {
        ...base,
        withLeasedWorkspace: (run, use, disposition) => {
          let leasedPath = ''
          return base.withLeasedWorkspace(
            run,
            (workspace) => {
              leasedPath = workspace.path
              acquired.push(workspace)
              return use(workspace)
            },
            (exit) => {
              const release = disposition(exit)
              released.push({ path: leasedPath, release })
              return release
            },
          )
        },
      }
    }

  it.effect('leases four concurrent runs four distinct workspaces', () =>
    Effect.gen(function* () {
      const issues = [1, 2, 3, 4].map((number) =>
        makeIssue(`example/sloppenheimer#${String(number)}`, 1, null, ['sloppenheimer', 'ready']),
      )
      const concurrent: Workflow = {
        ...workflow,
        config: {
          ...workflow.config,
          agent: { ...workflow.config.agent, maxConcurrentAgents: 4 },
        },
      }
      const harness = makeHarness(concurrent, () => issues)
      const acquired: Workspace[] = []
      const released: Readonly<{ path: string; release: WorkspaceRelease }>[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeWorkspaces: recordingWorkspaces(harness, acquired, released),
      }

      const running = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.counts.running < 4) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          return { counts: current.counts, releasedWhileRunning: [...released] }
        }),
      )

      // Four sessions running at once are four run identities, and so four workspaces: nothing is
      // shared, and no lease is let go of while its run is still live.
      expect(running.counts.running).toBe(4)
      expect(new Set(acquired.map((workspace) => workspace.path)).size).toBe(4)
      expect(running.releasedWhileRunning).toEqual([])
      // Closing the host interrupts all four, and every one of them gives its lease back.
      expect(new Set(released.map((each) => each.path))).toEqual(
        new Set(acquired.map((workspace) => workspace.path)),
      )
    }),
  )

  it.effect('keeps a cancelled run workspace for recovery', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#1', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(workflow, () => [issue])
      const acquired: Workspace[] = []
      const released: Readonly<{ path: string; release: WorkspaceRelease }>[] = []
      const ports: TestPorts = {
        ...harness.ports,
        makeWorkspaces: recordingWorkspaces(harness, acquired, released),
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* harness.awaitAgentRun
          yield* control.setIssuePaused(1, true)
        }),
      )

      // The pause interrupts the worker, and an interrupted run has published nothing: its
      // workspace is kept, under the reason it is being kept for.
      expect(released).toEqual([
        {
          path: acquired[0]?.path,
          release: { _tag: 'Retained', reason: 'run cancelled before publication' },
        },
      ])
    }),
  )

  it.effect('keeps the workspace of a run that had no source control to publish through', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#1', 1, null, ['sloppenheimer', 'ready'])
      const unpublished: Workflow = {
        ...workflow,
        config: { ...workflow.config, handoffEnabled: false },
      }
      const harness = makeHarness(unpublished, () => [issue])
      const acquired: Workspace[] = []
      const released: Readonly<{ path: string; release: WorkspaceRelease }>[] = []
      // Composing no code-review services is what disables handoff, and this composition supplies
      // no source control either: the run reaches its end having published nothing, so what the
      // agent wrote is still only in the workspace.
      const { makeCodeReview: _withoutCodeReview, ...withoutHandoff } = harness.ports
      const ports: TestPorts = {
        ...withoutHandoff,
        makeWorkspaces: recordingWorkspaces(harness, acquired, released),
        runAgent: () => Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (released.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          return current
        }),
      )

      expect(released[0]).toMatchObject({
        path: acquired[0]?.path,
        release: { _tag: 'Retained', reason: 'run ended without publishing its work' },
      })
    }),
  )

  it.effect('leases a retry its own workspace and keeps the failed attempt', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#1', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(workflow, () => [issue])
      const acquired: Workspace[] = []
      const released: Readonly<{ path: string; release: WorkspaceRelease }>[] = []
      let launches = 0
      const ports: TestPorts = {
        ...harness.ports,
        makeWorkspaces: recordingWorkspaces(harness, acquired, released),
        // The first attempt fails, which is what queues the retry; the second one stays running.
        runAgent: (launch) =>
          Effect.suspend(() => {
            launches += 1
            return launches === 1
              ? Effect.fail(
                  new AgentError({ category: 'process_exited', message: 'worker failed' }),
                )
              : harness.ports.runAgent(launch)
          }),
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          let current = yield* control.snapshot
          while (current.retrying.length === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
          yield* TestClock.adjust('20 seconds')
          while (current.counts.running === 0) {
            yield* Effect.yieldNow()
            current = yield* control.snapshot
          }
        }),
      )

      // The retry starts in a workspace of its own, and the attempt that failed keeps its own
      // rather than handing its leftovers to the run that follows it.
      expect(acquired).toHaveLength(2)
      expect(acquired[1]?.path).not.toBe(acquired[0]?.path)
      expect(released[0]).toMatchObject({
        path: acquired[0]?.path,
        // The reason names what failed, not what it said: a failure message can carry an excerpt
        // of what an agent or hook wrote, and the lease record is a file rather than a log.
        release: {
          _tag: 'Retained',
          reason: 'run failed before publication: AgentError process_exited',
        },
      })
    }),
  )
})

describe('tracker credential revalidation', (): void => {
  it.effect('updates the tracker used by an active worker issue refresh', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#1', 1, null, ['sloppenheimer', 'ready'])
      const environment: Record<string, string> = { SLOPPENHEIMER_TEST_TOKEN: 'secret' }
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* harness.awaitAgentRun
          environment['SLOPPENHEIMER_TEST_TOKEN'] = 'rotated'
          yield* control.refresh
          yield* refreshActiveIssue()
        }),
      )

      expect(harness.idFetchTokens().at(-1)).toBe('rotated')
    }),
  )

  it.effect("routes a live session's host tool calls to the tracker a rotation installed", () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#1', 1, null, ['sloppenheimer', 'ready'])
      const environment: Record<string, string> = { SLOPPENHEIMER_TEST_TOKEN: 'secret' }
      const harness = makeHarness(workflow, () => [issue])
      const executedTokens: string[] = []
      let session: HostToolSession | null = null
      const ports: TestPorts = {
        ...harness.ports,
        environment,
        makeTracker: (provider) => ({
          ...harness.ports.makeTracker(provider),
          toolSpecs: [
            { name: 'sloppenheimer_issue_state', description: 'set state', inputSchema: {} },
          ],
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
          await current.execute('sloppenheimer_issue_state', null, current.context)
        })
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* harness.awaitAgentRun
          environment['SLOPPENHEIMER_TEST_TOKEN'] = 'rotated'
          yield* control.refresh
          yield* callHostTool()
        }),
      )

      expect(executedTokens).toEqual(['rotated'])
    }),
  )

  it.effect('rebuilds the tracker when the referenced secret is rotated in the environment', () =>
    Effect.gen(function* () {
      const environment: Record<string, string> = { SLOPPENHEIMER_TEST_TOKEN: 'first' }
      const harness = makeHarness(workflow)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            environment,
          })
          yield* control.refresh
          environment['SLOPPENHEIMER_TEST_TOKEN'] = 'rotated'
          yield* control.refresh
        }),
      )

      // Twice at startup: the layer builds the first instance from the workflow the composition root
      // read, and the orchestrator replaces it with one built from the workflow it loaded itself.
      expect(
        harness.trackerProviders().map((each) => Redacted.value(githubProviderOf(each).token)),
      ).toEqual(['secret', 'secret', 'first', 'rotated'])
    }),
  )

  it.effect('launches with runner settings a rotation revalidated, not the startup value', () =>
    Effect.gen(function* () {
      // Preflight runs before every dispatch and revalidates both selections. It used to return
      // only the tracker's, so a rotated runner credential passed preflight — it was revalidated —
      // and the session then launched with the superseded value. Codex caught this on #218.
      const environment: Record<string, string> = {
        SLOPPENHEIMER_TEST_TOKEN: 'secret',
        AURORA_TEMPO: 'largo',
      }
      const environmentWorkflow: Workflow = {
        ...workflow,
        runner: Effect.runSync(
          withEnvironment(
            auroraRunners.validate('aurora', { tempo: '$AURORA_TEMPO' }),
            environment,
          ),
        ),
        config: {
          ...workflow.config,
          runner: { ...workflow.config.runner, settings: { tempo: '$AURORA_TEMPO' } },
        },
      }
      let issue = makeIssue('example/sloppenheimer#71', 1, null, ['sloppenheimer', 'ready'])
      const harness = makeHarness(environmentWorkflow, () => [issue])
      const launched: unknown[] = []
      const ports: TestPorts = {
        ...harness.ports,
        environment,
        // Settles immediately, unlike the harness default, so a second issue can be dispatched
        // under this workflow's concurrency limit of one.
        runAgent: (launch) =>
          Effect.sync(() => {
            launched.push(launch.config.settings)
            return { threadId: 'thread-1', turnId: 'turn-1', turnCount: 1 }
          }),
      }
      const awaitLaunch = (count: number): Effect.Effect<void> =>
        Effect.iterate(0, {
          while: (attempt) => launched.length < count && attempt < 200,
          body: (attempt) => Effect.as(Effect.yieldNow(), attempt + 1),
        }).pipe(Effect.asVoid)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          yield* awaitLaunch(1)
          environment['AURORA_TEMPO'] = 'presto'
          issue = makeIssue('example/sloppenheimer#72', 1, null, ['sloppenheimer', 'ready'])
          yield* control.refresh
          yield* awaitLaunch(2)
        }),
      )

      expect(launched).toEqual([{ tempo: 'largo' }, { tempo: 'presto' }])
    }),
  )

  it.effect('retains the last known good tracker when the secret disappears', () =>
    Effect.gen(function* () {
      const environment: Record<string, string> = { SLOPPENHEIMER_TEST_TOKEN: 'first' }
      const harness = makeHarness(workflow)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.ports,
            environment,
          })
          yield* control.refresh
          delete environment['SLOPPENHEIMER_TEST_TOKEN']
          yield* control.refresh
        }),
      )

      expect(
        harness.trackerProviders().map((each) => Redacted.value(githubProviderOf(each).token)),
      ).toEqual(['secret', 'secret', 'first'])
    }),
  )
})

describe('rebuilt port lifecycle', (): void => {
  it.effect('keeps the tracker a rotation replaced until the run that used it ends', () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#1', 1, null, ['sloppenheimer', 'ready'])
      const environment: Record<string, string> = { SLOPPENHEIMER_TEST_TOKEN: 'secret' }
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* Effect.promise(() => started)
          environment['SLOPPENHEIMER_TEST_TOKEN'] = 'rotated'
          yield* control.refresh

          expect(
            harness.trackerProviders().map((each) => Redacted.value(githubProviderOf(each).token)),
          ).toEqual(['secret', 'secret', 'rotated'])
          // Only the layer's instance, replaced at startup before any run could reach it. The
          // running worker adopted the rotated tracker, but a call it made a moment earlier may
          // still be awaiting the one it replaced.
          expect(harness.releasedTrackers()).toHaveLength(1)

          finishWorker()
          // Waited for rather than counted in refreshes: what is under test is that the release
          // happens once the run ends, not how many passes that takes.
          while (harness.releasedTrackers().length < 2) {
            yield* Effect.yieldNow()
            yield* control.refresh
          }

          expect(
            harness.releasedTrackers().map((each) => Redacted.value(githubProviderOf(each).token)),
          ).toEqual(['secret', 'secret'])
        }),
      )
    }),
  )

  it.effect('retires what a refused reload replaced before it refused', () =>
    Effect.gen(function* () {
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* control.refresh
          const beforeReload = harness.releasedTrackers().length
          const candidateFetchesBeforeReload = harness.stateFetches()

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
          expect(harness.stateFetches()).toBe(candidateFetchesBeforeReload)
          expect(harness.releasedTrackers().length).toBeGreaterThan(beforeReload)
        }),
      )
    }),
  )

  it.scoped("releases a run's superseded ports when it ends, even as its handoff lives on", () =>
    Effect.gen(function* () {
      const issue = makeIssue('example/sloppenheimer#1', 1, null, ['sloppenheimer', 'ready'])
      const environment: Record<string, string> = { SLOPPENHEIMER_TEST_TOKEN: 'secret' }
      let markStarted = (): void => undefined
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      let finishWorker = (): void => undefined
      const finished = new Promise<void>((resolve) => {
        finishWorker = resolve
      })
      // An isolated root: this run really does hand off, so it reads and writes a handoff store.
      const workspaceRoot = yield* isolatedWorkspaceRoot('sloppenheimer-superseded-handoff-')
      const isolated: Workflow = { ...workflow, config: { ...workflow.config, workspaceRoot } }
      const harness = makeHarness(isolated, () => [issue], undefined, environment)
      const ports: TestPorts = {
        ...harness.ports,
        makeCodeReview: (provider) => ({
          ...requireCodeReview(harness.ports, provider),
          handoffCompletedWork: () =>
            Effect.succeed({
              _tag: 'PullRequest' as const,
              branchName: 'sloppenheimer/issue-1',
              pullRequestUrl: 'https://github.test/example/sloppenheimer/pull/65',
              pullRequestNumber: 65,
              created: true,
            }),
          inspectPullRequest: (number) =>
            Effect.succeed({
              number,
              state: 'open' as const,
              url: 'https://github.test/example/sloppenheimer/pull/65',
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

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startTestOrchestrator('/tmp/WORKFLOW.md', ports)
          yield* Effect.promise(() => started)
          environment['SLOPPENHEIMER_TEST_TOKEN'] = 'rotated'
          yield* control.refresh
          expect(harness.releasedTrackers()).toHaveLength(1)

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
    'keeps reporting an evicted session as completed on later publications',
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
                codexReview: { headShaPrefix: `head-${String(number)}`, status: 'pending' },
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
        )

        expect(observed.after).toEqual({ _tag: 'Completed', identifier: observed.evicted })
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
                codexReview: { headShaPrefix: head.slice(0, 7), status: 'pending' as const },
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
