import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect, Layer, Redacted } from 'effect'
import { afterEach, describe, expect, vi } from 'vitest'

import type { WorkflowError } from '@sloppenheimer/core/domain/errors.js'
import {
  issueId,
  issueIdentifier,
  type BlockerRef,
  type Issue,
  type JsonObject,
} from '@sloppenheimer/core/domain/domain.js'
import { buildBacklogSnapshot, makeOperatorBackend } from '../../src/operator/operator.js'
import {
  layerGitHubIssueControl,
  makeGitHubIssueControl,
} from '@sloppenheimer/adapter-github/issues.js'
import type { OperatorBackend } from '../../src/operator/operator.js'
import type { OrchestratorControl, OrchestratorSnapshot } from '@sloppenheimer/core'
import {
  CurrentIssueControl,
  layerCurrentIssueControl,
  layerIssueControlFactory,
  layerWorkflowLoader,
  type IssueControlPort,
} from '@sloppenheimer/core'
import { loadWorkflow, preflightWorkflow } from '../../src/config/workflow.js'
import { trackerProviders } from '../../src/tracker-adapters.js'
import { hostFileSystem } from '../harness/filesystem.js'
import { githubProviderOf, type GitHubProviderConfig } from '@sloppenheimer/adapter-github'
import { workflowAdaptersFor } from '../harness/workflow-adapters.js'
import { anIssue } from '../harness/fixtures.js'

const temporaryDirectories: string[] = []

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'sloppenheimer',
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
  pull_request: {
    url: `https://api.example.test/repos/example/sloppenheimer/pulls/${String(number)}`,
  },
})

afterEach(async (): Promise<void> => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

const blocker = (number: number, state = 'open'): BlockerRef => ({
  id: String(10_000 + number),
  identifier: issueIdentifier(`example/sloppenheimer#${String(number)}`),
  title: `Issue ${String(number)}`,
  state,
  url: `https://github.com/example/sloppenheimer/issues/${String(number)}`,
})

const issue = (number: number, blockers: readonly BlockerRef[] = []): Issue =>
  anIssue({
    id: issueId(String(number)),
    identifier: issueIdentifier(`example/sloppenheimer#${String(number)}`),
    title: `Issue ${String(number)}`,
    url: `https://github.com/example/sloppenheimer/issues/${String(number)}`,
    labels: [],
    blockedBy: blockers,
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
  counts: { running: 0, retrying: 0, delivering: 0, completed: 0 },
  completed: [],
  saturatedStates: [],
  inspectableAgents: [],
  pausedIssueNumbers,
  handoffs: [],
  running: [],
  retrying: [],
  delivering: [],
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
    refresh: Effect.succeed({
      coalesced: false,
      requestedAt: '2026-08-30T00:00:00.000Z',
      operations: [],
    }),
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
  load: (path) =>
    loadWorkflow(path, workflowAdaptersFor(trackerProviders)).pipe(Effect.provide(hostFileSystem)),
  preflight: (workflow) => preflightWorkflow(workflow),
})

/** Builds the backend and hands it to the case, with its layers provided once. */
const runBackend = <Value, Error>(
  workflowPath: string,
  orchestrator: OrchestratorControl,
  use: (backend: OperatorBackend) => Effect.Effect<Value, Error>,
  layer: Layer.Layer<CurrentIssueControl> = gitHubIssueControl,
): Effect.Effect<Value, Error | WorkflowError> =>
  makeOperatorBackend(workflowPath, orchestrator).pipe(
    Effect.flatMap(use),
    Effect.provide(layer),
    Effect.provide(workflowLoader),
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
      labels: ['sloppenheimer'],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    },
  ])
}

const temporaryWorkflow = (): Effect.Effect<string> =>
  Effect.promise(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppenheimer-operator-test-'))
    temporaryDirectories.push(directory)
    const workflowPath = join(directory, 'WORKFLOW.md')
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github
  provider:
    owner: example
    repository: sloppenheimer
    token: $TEST_OPERATOR_GITHUB_TOKEN
    api_base_url: https://api.example.test
  required_labels: [sloppenheimer]
---
Do the work
`,
    )
    return workflowPath
  })

describe('operator dependency graph', (): void => {
  it.effect('filters non-dispatchable records out of the operator backlog', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        return url.includes('/dependencies/blocked_by')
          ? Response.json([])
          : Response.json([githubIssue(1), githubPullRequest(2)])
      })
      vi.stubGlobal('fetch', fetchMock)

      const issues = yield* (yield* makeGitHubIssueControl(provider)).listOpenIssues()

      expect(issues.map((issue) => issue.id)).toEqual(['1'])
    }),
  )

  it('builds deterministic nodes and blocker-to-dependent edges for mixed graph shapes', (): void => {
    const snapshot = buildBacklogSnapshot(
      [
        issue(1),
        issue(2, [blocker(1)]),
        issue(3, [blocker(1)]),
        issue(4, [blocker(2), blocker(3)]),
        issue(5),
      ],
      'sloppenheimer',
      ['closed'],
    )

    expect(snapshot.nodes.map((node) => node.identifier)).toEqual([
      'example/sloppenheimer#1',
      'example/sloppenheimer#2',
      'example/sloppenheimer#3',
      'example/sloppenheimer#4',
      'example/sloppenheimer#5',
    ])
    expect(snapshot.edges).toEqual([
      { blocker: 'example/sloppenheimer#1', dependent: 'example/sloppenheimer#2' },
      { blocker: 'example/sloppenheimer#1', dependent: 'example/sloppenheimer#3' },
      { blocker: 'example/sloppenheimer#2', dependent: 'example/sloppenheimer#4' },
      { blocker: 'example/sloppenheimer#3', dependent: 'example/sloppenheimer#4' },
    ])
    expect(snapshot.issues.map(({ number, readiness }) => [number, readiness])).toEqual([
      [1, 'ready'],
      [2, 'blocked'],
      [3, 'blocked'],
      [4, 'blocked'],
      [5, 'ready'],
    ])
  })

  it('counts how much work each issue unblocks, transitively', (): void => {
    const snapshot = buildBacklogSnapshot(
      [
        issue(1),
        issue(2, [blocker(1)]),
        issue(3, [blocker(1)]),
        issue(4, [blocker(2), blocker(3)]),
        issue(5),
      ],
      'sloppenheimer',
      ['closed'],
    )

    const unlocks = new Map(snapshot.issues.map((entry) => [entry.number, entry.unlocks]))
    // #1 frees #2 and #3, and #4 only because finishing #1 clears both of its blockers at once.
    expect(unlocks.get(1)).toBe(3)
    // #4 is blocked by both #2 and #3, so neither of them frees it on its own.
    expect(unlocks.get(2)).toBe(0)
    expect(unlocks.get(3)).toBe(0)
    expect(unlocks.get(4)).toBe(0)
    expect(unlocks.get(5)).toBe(0)
  })

  it('does not credit an issue with unlocking work another blocker still holds', (): void => {
    const snapshot = buildBacklogSnapshot(
      // #12 is blocked by #10 and by #11; #13 waits on #12.
      [issue(10), issue(11), issue(12, [blocker(10), blocker(11)]), issue(13, [blocker(12)])],
      'sloppenheimer',
      ['closed'],
    )

    const unlocks = new Map(snapshot.issues.map((entry) => [entry.number, entry.unlocks]))
    expect(unlocks.get(10)).toBe(0)
    expect(unlocks.get(11)).toBe(0)
    expect(unlocks.get(12)).toBe(1)
  })

  it('ignores a blocker that is already in a terminal state', (): void => {
    const snapshot = buildBacklogSnapshot(
      // #21 is closed, so it is not holding #22 back and #20 alone frees it.
      [issue(20), issue(22, [blocker(20), blocker(21, 'closed')])],
      'sloppenheimer',
      ['closed'],
    )

    expect(snapshot.issues.find(({ number }) => number === 20)?.unlocks).toBe(1)
  })

  it('counts downstream work without diverging on a dependency cycle', (): void => {
    const snapshot = buildBacklogSnapshot(
      [issue(6, [blocker(7)]), issue(7, [blocker(6)]), issue(8, [blocker(6)])],
      'sloppenheimer',
      ['closed'],
    )

    const unlocks = new Map(snapshot.issues.map((entry) => [entry.number, entry.unlocks]))
    expect(unlocks.get(6)).toBe(2)
    expect(unlocks.get(7)).toBe(2)
    expect(unlocks.get(8)).toBe(0)
  })

  it('exposes cycle diagnostics and completed external blockers', (): void => {
    const snapshot = buildBacklogSnapshot(
      [issue(6, [blocker(7)]), issue(7, [blocker(6)]), issue(8, [blocker(9, 'closed')])],
      'sloppenheimer',
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
      blocker: 'example/sloppenheimer#9',
      dependent: 'example/sloppenheimer#8',
    })
  })

  it.effect('reuses dependency hydration across repeated backlog snapshots', () =>
    Effect.gen(function* () {
      const workflowPath = yield* temporaryWorkflow()
      vi.stubEnv('TEST_OPERATOR_GITHUB_TOKEN', 'secret')
      const fetchMock = vi.fn(openIssueResponse)
      vi.stubGlobal('fetch', fetchMock)
      const setIssuePaused = vi.fn()

      yield* runBackend(
        workflowPath,
        fakeOrchestrator(setIssuePaused),
        (backend: OperatorBackend) =>
          Effect.gen(function* () {
            yield* backend.backlog
            yield* backend.backlog
            yield* backend.setIssueEnabled(1, false)
          }),
      )

      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(setIssuePaused).toHaveBeenCalledWith(1, true)
    }),
  )

  it.effect('rebuilds the issue control only when the workflow names a different provider', () =>
    Effect.gen(function* () {
      const workflowPath = yield* temporaryWorkflow()
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

      yield* runBackend(
        workflowPath,
        fakeOrchestrator(),
        (backend: OperatorBackend) =>
          Effect.gen(function* () {
            yield* backend.backlog
            yield* backend.backlog
            vi.stubEnv('TEST_OPERATOR_GITHUB_TOKEN', 'rotated')
            yield* backend.backlog
          }),
        layerCurrentIssueControl.pipe(Layer.provide(factory)),
      )

      expect(built).toEqual(['secret', 'rotated'])
    }),
  )

  it.effect('reports the orchestrator paused set rather than a copy of its own', () =>
    Effect.gen(function* () {
      const workflowPath = yield* temporaryWorkflow()
      vi.stubEnv('TEST_OPERATOR_GITHUB_TOKEN', 'secret')
      vi.stubGlobal('fetch', vi.fn(openIssueResponse))
      const orchestrator = fakeOrchestrator()

      const enabled = yield* runBackend(workflowPath, orchestrator, (backend: OperatorBackend) =>
        Effect.gen(function* () {
          const before = yield* backend.backlog
          // The pause originates outside the console, as one issued through the orchestrator does.
          yield* orchestrator.setIssuePaused(1, true)
          const after = yield* backend.backlog
          return [before.issues[0]?.enabled, after.issues[0]?.enabled]
        }),
      )

      expect(enabled).toEqual([true, false])
    }),
  )

  it.effect('drives the backlog from an issue-control layer that is not GitHub', () =>
    Effect.gen(function* () {
      const workflowPath = yield* temporaryWorkflow()
      vi.stubEnv('TEST_OPERATOR_GITHUB_TOKEN', 'secret')
      const addLabel = vi.fn((issueNumber: number, label: string) => [issueNumber, label])
      const control: IssueControlPort = {
        listOpenIssues: () => Effect.succeed([{ ...issue(1), labels: ['sloppenheimer'] }]),
        addLabel: (issueNumber, label) => {
          addLabel(issueNumber, label)
          return Effect.void
        },
      }
      const orchestrator = fakeOrchestrator()

      const snapshot = yield* runBackend(
        workflowPath,
        orchestrator,
        (backend: OperatorBackend) =>
          Effect.gen(function* () {
            yield* backend.setIssueEnabled(1, true)
            return yield* backend.backlog
          }),
        layerCurrentIssueControl.pipe(
          Layer.provide(
            layerIssueControlFactory({ make: () => Effect.succeed(control), serves: () => true }),
          ),
        ),
      )

      expect(addLabel).toHaveBeenCalledWith(1, 'sloppenheimer')
      expect(snapshot.issues.map(({ number, enabled }) => [number, enabled])).toEqual([[1, true]])
    }),
  )
})
