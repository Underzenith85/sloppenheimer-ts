import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, Redacted } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  issueId,
  issueIdentifier,
  type BlockerRef,
  type Issue,
  type JsonObject,
} from '../../src/domain/domain.js'
import { buildBacklogSnapshot, makeOperatorBackend } from '../../src/operator/operator.js'
import {
  layerGitHubIssueControl,
  makeGitHubIssueControl,
} from '../../src/adapters/github/issues.js'
import type { OperatorBackend } from '../../src/operator/operator.js'
import type { OrchestratorControl, OrchestratorSnapshot } from '../../src/core/orchestrator.js'
import {
  CurrentIssueControl,
  layerCurrentIssueControl,
  layerIssueControlFactory,
  layerWorkflowLoader,
  type IssueControlPort,
} from '../../src/ports/index.js'
import { loadWorkflow, preflightWorkflow } from '../../src/config/workflow.js'
import { trackerProviders } from '../../src/tracker-adapters.js'
import { githubProviderOf, type GitHubProviderConfig } from '../../src/adapters/github/index.js'

const temporaryDirectories: string[] = []

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'symphony',
  token: Redacted.make('secret'),
  tokenEnvironmentName: 'TEST_OPERATOR_GITHUB_TOKEN',
  apiBaseUrl: 'https://api.example.test',
  baseBranch: 'main',
}

const githubIssue = (number: number): JsonObject => ({
  number,
  node_id: `node-${String(number)}`,
  title: `Issue ${String(number)}`,
  body: null,
  state: 'open',
  html_url: `https://example.test/issues/${String(number)}`,
  assignee: null,
  labels: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
})

const githubPullRequest = (number: number): JsonObject => ({
  ...githubIssue(number),
  pull_request: { url: `https://api.example.test/repos/example/symphony/pulls/${String(number)}` },
})

afterEach(async (): Promise<void> => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

const blocker = (number: number, state = 'open'): BlockerRef => ({
  id: String(10_000 + number),
  identifier: issueIdentifier(`example/symphony#${String(number)}`),
  title: `Issue ${String(number)}`,
  state,
  url: `https://github.com/example/symphony/issues/${String(number)}`,
})

const issue = (number: number, blockers: readonly BlockerRef[] = []): Issue => ({
  id: issueId(String(number)),
  nativeRef: null,
  identifier: issueIdentifier(`example/symphony#${String(number)}`),
  title: `Issue ${String(number)}`,
  description: null,
  priority: null,
  state: 'open',
  branchName: null,
  url: `https://github.com/example/symphony/issues/${String(number)}`,
  assigneeId: null,
  labels: [],
  blockedBy: blockers,
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
})

const orchestratorSnapshot = (pausedIssueNumbers: readonly number[]): OrchestratorSnapshot => ({
  generatedAt: '2026-08-30T00:00:00.000Z',
  workflowPath: '/isolated/WORKFLOW.md',
  effectiveWorkflow: { fingerprint: 'operator', loadedAt: '2026-08-30T00:00:00.000Z' },
  workflowReloadError: null,
  handoffRecovery: {
    status: 'completed',
    loaded: 0,
    recovered: 0,
    skipped: 0,
    failed: 0,
    storeError: null,
  },
  pollingIntervalMs: 30_000,
  maxConcurrentAgents: 1,
  counts: { running: 0, retrying: 0, completed: 0 },
  pausedIssueNumbers,
  handoffs: [],
  running: [],
  retrying: [],
  totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
  rateLimits: null,
})

/**
 * An orchestrator that owns the paused set, as the real one does: pausing an issue is what makes it
 * appear in the next snapshot, and nothing else records it.
 */
const fakeOrchestrator = (
  setIssuePaused: (issueNumber: number, paused: boolean) => void = () => undefined,
): OrchestratorControl => {
  const paused = new Set<number>()
  return {
    snapshot: Effect.sync(() => orchestratorSnapshot([...paused])),
    refresh: Effect.void,
    agentDetail: (identifier) => Effect.succeed({ _tag: 'Unknown', identifier }),
    setIssuePaused: (issueNumber, isPaused) =>
      Effect.sync(() => {
        if (isPaused) {
          paused.add(issueNumber)
        } else {
          paused.delete(issueNumber)
        }
        setIssuePaused(issueNumber, isPaused)
      }),
    awaitTermination: Effect.never,
  }
}

const gitHubIssueControl = layerCurrentIssueControl.pipe(Layer.provide(layerGitHubIssueControl))

/** The console reads the workflow through the loader the composition root binds. */
const workflowLoader = layerWorkflowLoader({
  load: (path) => loadWorkflow(path, trackerProviders),
  preflight: (workflow) => preflightWorkflow(workflow),
})

const runBackend = <Value>(
  workflowPath: string,
  orchestrator: OrchestratorControl,
  use: (backend: OperatorBackend) => Promise<Value>,
  layer: Layer.Layer<CurrentIssueControl> = gitHubIssueControl,
): Promise<Value> =>
  Effect.runPromise(
    makeOperatorBackend(workflowPath, orchestrator).pipe(
      Effect.flatMap((backend) => Effect.promise(() => use(backend))),
      Effect.provide(layer),
      Effect.provide(workflowLoader),
    ),
  )

const openIssueResponse = async (input: string | URL | Request): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('/dependencies/blocked_by')) {
    return Response.json([])
  }
  return Response.json([
    {
      number: 1,
      node_id: 'node-1',
      title: 'Issue 1',
      body: null,
      state: 'open',
      html_url: 'https://example.test/issues/1',
      assignee: null,
      labels: ['symphony'],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    },
  ])
}

const temporaryWorkflow = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'symphony-operator-test-'))
  temporaryDirectories.push(directory)
  const workflowPath = join(directory, 'WORKFLOW.md')
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TEST_OPERATOR_GITHUB_TOKEN
    api_base_url: https://api.example.test
  required_labels: [symphony]
---
Do the work
`,
  )
  return workflowPath
}

describe('operator dependency graph', (): void => {
  it('filters non-dispatchable records out of the operator backlog', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.includes('/dependencies/blocked_by')
        ? Response.json([])
        : Response.json([githubIssue(1), githubPullRequest(2)])
    })
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(makeGitHubIssueControl(provider).listOpenIssues())

    expect(issues.map((issue) => issue.id)).toEqual(['1'])
  })

  it('builds deterministic nodes and blocker-to-dependent edges for mixed graph shapes', (): void => {
    const snapshot = buildBacklogSnapshot(
      [
        issue(1),
        issue(2, [blocker(1)]),
        issue(3, [blocker(1)]),
        issue(4, [blocker(2), blocker(3)]),
        issue(5),
      ],
      'symphony',
      ['closed'],
    )

    expect(snapshot.nodes.map((node) => node.identifier)).toEqual([
      'example/symphony#1',
      'example/symphony#2',
      'example/symphony#3',
      'example/symphony#4',
      'example/symphony#5',
    ])
    expect(snapshot.edges).toEqual([
      { blocker: 'example/symphony#1', dependent: 'example/symphony#2' },
      { blocker: 'example/symphony#1', dependent: 'example/symphony#3' },
      { blocker: 'example/symphony#2', dependent: 'example/symphony#4' },
      { blocker: 'example/symphony#3', dependent: 'example/symphony#4' },
    ])
    expect(snapshot.issues.map(({ number, readiness }) => [number, readiness])).toEqual([
      [1, 'ready'],
      [2, 'blocked'],
      [3, 'blocked'],
      [4, 'blocked'],
      [5, 'ready'],
    ])
  })

  it('exposes cycle diagnostics and completed external blockers', (): void => {
    const snapshot = buildBacklogSnapshot(
      [issue(6, [blocker(7)]), issue(7, [blocker(6)]), issue(8, [blocker(9, 'closed')])],
      'symphony',
      ['closed'],
    )

    expect(snapshot.cycles).toHaveLength(1)
    expect(snapshot.issues.find(({ number }) => number === 6)?.readiness).toBe('cyclic')
    expect(snapshot.issues.find(({ number }) => number === 7)?.readiness).toBe('cyclic')
    expect(snapshot.issues.find(({ number }) => number === 8)?.readiness).toBe('ready')
    expect(snapshot.issues.find(({ number }) => number === 8)?.blockedBy).toEqual([])
    expect(snapshot.nodes.find(({ identifier }) => identifier.endsWith('#9'))?.readiness).toBe(
      'completed',
    )
    expect(snapshot.edges).toContainEqual({
      blocker: 'example/symphony#9',
      dependent: 'example/symphony#8',
    })
  })

  it('reuses dependency hydration across repeated backlog snapshots', async (): Promise<void> => {
    const workflowPath = await temporaryWorkflow()
    vi.stubEnv('TEST_OPERATOR_GITHUB_TOKEN', 'secret')
    const fetchMock = vi.fn(openIssueResponse)
    vi.stubGlobal('fetch', fetchMock)
    const setIssuePaused = vi.fn()

    await runBackend(workflowPath, fakeOrchestrator(setIssuePaused), async (backend) => {
      await Effect.runPromise(backend.backlog)
      await Effect.runPromise(backend.backlog)
      await Effect.runPromise(backend.setIssueEnabled(1, false))
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(setIssuePaused).toHaveBeenCalledWith(1, true)
  })

  it('rebuilds the issue control only when the workflow names a different provider', async (): Promise<void> => {
    const workflowPath = await temporaryWorkflow()
    vi.stubEnv('TEST_OPERATOR_GITHUB_TOKEN', 'secret')
    vi.stubGlobal('fetch', vi.fn(openIssueResponse))
    const built: string[] = []
    const factory = layerIssueControlFactory({
      make: (provider) =>
        Effect.sync((): IssueControlPort => {
          built.push(Redacted.value(githubProviderOf(provider).token))
          return { listOpenIssues: () => Effect.succeed([]), addLabel: () => Effect.void }
        }),
      serves: (left, right) =>
        Redacted.value(githubProviderOf(left).token) ===
        Redacted.value(githubProviderOf(right).token),
    })

    await runBackend(
      workflowPath,
      fakeOrchestrator(),
      async (backend) => {
        await Effect.runPromise(backend.backlog)
        await Effect.runPromise(backend.backlog)
        vi.stubEnv('TEST_OPERATOR_GITHUB_TOKEN', 'rotated')
        await Effect.runPromise(backend.backlog)
      },
      layerCurrentIssueControl.pipe(Layer.provide(factory)),
    )

    expect(built).toEqual(['secret', 'rotated'])
  })

  it('reports the orchestrator paused set rather than a copy of its own', async (): Promise<void> => {
    const workflowPath = await temporaryWorkflow()
    vi.stubEnv('TEST_OPERATOR_GITHUB_TOKEN', 'secret')
    vi.stubGlobal('fetch', vi.fn(openIssueResponse))
    const orchestrator = fakeOrchestrator()

    const enabled = await runBackend(workflowPath, orchestrator, async (backend) => {
      const before = await Effect.runPromise(backend.backlog)
      // The pause originates outside the console, as one issued through the orchestrator does.
      await Effect.runPromise(orchestrator.setIssuePaused(1, true))
      const after = await Effect.runPromise(backend.backlog)
      return [before.issues[0]?.enabled, after.issues[0]?.enabled]
    })

    expect(enabled).toEqual([true, false])
  })

  it('drives the backlog from an issue-control layer that is not GitHub', async (): Promise<void> => {
    const workflowPath = await temporaryWorkflow()
    vi.stubEnv('TEST_OPERATOR_GITHUB_TOKEN', 'secret')
    const addLabel = vi.fn((issueNumber: number, label: string) => [issueNumber, label])
    const control: IssueControlPort = {
      listOpenIssues: () => Effect.succeed([{ ...issue(1), labels: ['symphony'] }]),
      addLabel: (issueNumber, label) => {
        addLabel(issueNumber, label)
        return Effect.void
      },
    }
    const orchestrator = fakeOrchestrator()

    const snapshot = await runBackend(
      workflowPath,
      orchestrator,
      async (backend) => {
        await Effect.runPromise(backend.setIssueEnabled(1, true))
        return Effect.runPromise(backend.backlog)
      },
      layerCurrentIssueControl.pipe(
        Layer.provide(
          layerIssueControlFactory({ make: () => Effect.succeed(control), serves: () => true }),
        ),
      ),
    )

    expect(addLabel).toHaveBeenCalledWith(1, 'symphony')
    expect(snapshot.issues.map(({ number, enabled }) => [number, enabled])).toEqual([[1, true]])
  })
})
