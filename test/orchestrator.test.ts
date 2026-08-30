import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Fiber, TestClock, TestContext } from 'effect'
import { describe, expect, it } from 'vitest'

import { telemetryFrom, type AgentEvent, type AgentResult } from '../src/codex.js'
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
  codexAgentEventSemantics,
  type AgentDetailLookup,
  type OrchestratorControl,
  type OrchestratorDependencies,
} from '../src/orchestrator.js'
import { makeRedactor } from '../src/support/redaction.js'
import { normalizePayload, type AgentDetailSnapshot } from '../src/telemetry.js'
import type { CodeReviewPort, TrackerPort } from '../src/tracker.js'
import type { Workflow } from '../src/config/workflow.js'

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
    makeTracker: (effectiveWorkflow): TrackerPort => {
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
      handoffCompletedWork: () => Effect.succeed({ _tag: 'NoBranch', branchName: 'symphony/test' }),
      findExistingHandoff: () => Effect.succeed({ _tag: 'NoBranch', branchName: 'symphony/test' }),
      inspectPullRequest: () => Effect.die('unused'),
      mergePullRequest: () => Effect.die('unused'),
      requestPullRequestReview: () => Effect.die('unused'),
      resolveReviewThreads: () => Effect.die('unused'),
    }),
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

const requireCodeReview = (
  dependencies: OrchestratorDependencies,
  effectiveWorkflow: Workflow,
): CodeReviewPort => {
  const codeReview = dependencies.makeCodeReview?.(effectiveWorkflow)
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
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
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
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
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
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', harness.dependencies)
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
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeTracker: (effectiveWorkflow) => {
        const tracker = harness.dependencies.makeTracker(effectiveWorkflow)
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
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
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
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(inspections).toBe(1)
    expect(snapshot.handoffs).toEqual([])
    expect(snapshot.counts.completed).toBe(1)
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
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
          yield* control.refresh
          yield* control.refresh
          return yield* control.snapshot
        }),
      ),
    )

    expect(inspections).toBe(1)
    expect(snapshot.running).toEqual([])
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
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
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
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
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

  it('persists the repair marker while its agent is running', async (): Promise<void> => {
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
          state: 'repair_needed',
          headSha: reviewedHead,
          reason: 'Unresolved review feedback',
          repairAttempts: 0,
          reviewRequestedHeadSha: reviewedHead,
          reviewCompletedHeadSha: reviewedHead,
          observedAt: new Date(0).toISOString(),
        },
      ]),
    )
    const harness = makeHarness(isolated, () => [issue])
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
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
        repairAttempts: 1,
        reviewRequestedHeadSha: reviewedHead,
        reviewCompletedHeadSha: reviewedHead,
      }),
    ])
    await expect(Effect.runPromise(loadHandoffs(handoffStorePath))).resolves.toEqual([
      expect.objectContaining({ issueId: '20', repairAttempts: 1 }),
    ])
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
  runAgent: OrchestratorDependencies['runAgent']
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.dependencies,
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.dependencies,
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.dependencies,
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
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      runAgent: factory.runAgent,
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
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
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      runAgent: factory.runAgent,
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
        handoffCompletedWork: () =>
          blockHandoff
            ? Effect.sync(releaseHandoff).pipe(Effect.zipRight(Effect.never))
            : Effect.succeed({ _tag: 'NoBranch', branchName: 'symphony/issue-19' }),
      }),
    }

    const detail = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
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

  it('answers unknown, sessionless, and starting identifiers distinctly', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#14', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    const factory = makeAgentFactory()

    const lookups = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.dependencies,
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.dependencies,
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.dependencies,
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', {
            ...harness.dependencies,
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
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      runAgent: factory.runAgent,
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
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
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)
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
      makeCodeReview: (effectiveWorkflow) => ({
        ...requireCodeReview(harness.dependencies, effectiveWorkflow),
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

  it('uses continuation turns when the tracker has no CodeReviewPort and handoff is disabled', async (): Promise<void> => {
    const issue = makeIssue('example/symphony#139', 1, null, ['symphony', 'ready'])
    const harness = makeHarness(workflow, () => [issue])
    const { makeCodeReview: omittedCodeReview, ...trackerOnlyDependencies } = harness.dependencies
    void omittedCodeReview
    const dependencies: OrchestratorDependencies = {
      ...trackerOnlyDependencies,
      runAgent: () =>
        Effect.succeed({ threadId: 'thread-neutral', turnId: 'turn-neutral', turnCount: 1 }),
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
    const { makeCodeReview: omittedCodeReview, ...trackerOnlyDependencies } = harness.dependencies
    void omittedCodeReview

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', trackerOnlyDependencies)
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
    const dependencies: OrchestratorDependencies = {
      ...harness.dependencies,
      makeCodeReview: () => null,
    }

    const result = await Effect.runPromise(
      Effect.either(Effect.scoped(startOrchestrator('/tmp/WORKFLOW.md', dependencies))),
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
