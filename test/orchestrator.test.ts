import { Deferred, Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { cyclicIssueIdentifiers, findDependencyCycles } from '../src/dependencies.js'
import { issueId, issueIdentifier, type BlockerRef, type Issue } from '../src/domain.js'
import {
  issueIsRoutable,
  retryDelayMs,
  sortIssues,
  startOrchestrator,
  type OrchestratorDependencies,
} from '../src/orchestrator.js'
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

describe('orchestrator policies', (): void => {
  it('orders valid priority first, then creation time, then identifier', (): void => {
    const issues = [
      makeIssue('GH-3', null, '2026-01-01T00:00:00.000Z'),
      makeIssue('GH-2', 1, '2026-02-01T00:00:00.000Z'),
      makeIssue('GH-1', 1, '2026-01-01T00:00:00.000Z'),
    ]

    expect(sortIssues(issues).map((issue) => issue.identifier)).toEqual(['GH-1', 'GH-2', 'GH-3'])
  })

  it('keeps active sessions on their dispatch snapshot across workflow reloads', async (): Promise<void> => {
    const initial: Workflow = {
      ...workflow,
      fingerprint: 'initial',
      promptTemplate: 'Initial prompt for {{ issue.identifier }}',
      config: {
        ...workflow.config,
        tracker: {
          ...workflow.config.tracker,
          provider: { ...workflow.config.tracker.provider, token: 'initial-token' },
          requiredLabels: ['initial'],
        },
        workspaceRoot: '/tmp/initial-workspaces',
        hooks: { ...workflow.config.hooks, beforeRun: 'initial-hook' },
        agent: { ...workflow.config.agent, maxConcurrentAgents: 1, maxTurns: 2 },
        codex: { ...workflow.config.codex, command: 'initial-codex app-server' },
      },
    }
    const reloaded: Workflow = {
      ...initial,
      fingerprint: 'reloaded',
      promptTemplate: 'Reloaded prompt for {{ issue.identifier }}',
      config: {
        ...initial.config,
        tracker: {
          ...initial.config.tracker,
          provider: { ...initial.config.tracker.provider, token: 'reloaded-token' },
          requiredLabels: ['reloaded'],
        },
        workspaceRoot: '/tmp/reloaded-workspaces',
        hooks: { ...initial.config.hooks, beforeRun: 'reloaded-hook' },
        agent: { ...initial.config.agent, maxConcurrentAgents: 2, maxTurns: 7 },
        codex: { ...initial.config.codex, command: 'reloaded-codex app-server' },
      },
    }
    const initialIssue = makeIssue('GH-1', 1, null, ['initial'])
    const reloadedIssue = makeIssue('GH-2', 1, null, ['reloaded'])
    let selectedWorkflow = initial
    const trackerFactories: string[] = []
    const trackerRefreshes: string[] = []
    const workspaceFactories: string[] = []
    const beforeRuns: string[] = []
    const agentRuns: Array<
      Readonly<{
        identifier: string
        command: string
        prompt: string
        maxTurns: number
        secrets: readonly string[]
      }>
    > = []
    let initialContinuationRoutable: boolean | null = null

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const initialStarted = yield* Deferred.make<void, never>()
          const reloadedStarted = yield* Deferred.make<void, never>()
          const continueInitial = yield* Deferred.make<void, never>()
          const initialRefreshed = yield* Deferred.make<void, never>()
          const dependencies: OrchestratorDependencies = {
            loadWorkflow: () => Effect.succeed(selectedWorkflow),
            makeTracker: (effectiveWorkflow) => {
              const name = effectiveWorkflow.fingerprint
              trackerFactories.push(`${name}:${effectiveWorkflow.config.tracker.provider.token}`)
              return {
                fetchIssuesByStates: () =>
                  Effect.succeed(name === 'initial' ? [initialIssue] : [reloadedIssue]),
                fetchIssuesByIds: (ids) =>
                  Effect.sync(() => {
                    trackerRefreshes.push(`${name}:${ids.join(',')}`)
                    return ids.includes(initialIssue.id) ? [initialIssue] : [reloadedIssue]
                  }),
                handoffCompletedWork: () =>
                  Effect.succeed({
                    _tag: 'PullRequest',
                    branchName: 'branch',
                    pullRequestUrl: 'url',
                  }),
                secretEnvironmentNames: [`${name.toUpperCase()}_TOKEN`],
              }
            },
            makeWorkspaces: (effectiveWorkflow) => {
              const name = effectiveWorkflow.fingerprint
              workspaceFactories.push(
                `${name}:${effectiveWorkflow.config.workspaceRoot}:${effectiveWorkflow.config.hooks.beforeRun ?? ''}`,
              )
              return {
                create: (identifier) =>
                  Effect.succeed({
                    path: `/tmp/${name}/${identifier}`,
                    key: identifier,
                    createdNow: false,
                  }),
                beforeRun: (workspace) =>
                  Effect.sync(() => {
                    beforeRuns.push(`${name}:${workspace.key}`)
                  }),
                afterRun: () => Effect.void,
                remove: () => Effect.void,
              }
            },
            runAgent: (
              issue,
              _workspace,
              config,
              prompt,
              maxTurns,
              secretEnvironmentNames,
              refreshIssue,
              isRoutable,
            ) =>
              Effect.gen(function* () {
                agentRuns.push({
                  identifier: issue.identifier,
                  command: config.command,
                  prompt,
                  maxTurns,
                  secrets: secretEnvironmentNames,
                })
                if (issue.id === initialIssue.id) {
                  yield* Deferred.succeed(initialStarted, undefined)
                  yield* Deferred.await(continueInitial)
                  const refreshed = yield* refreshIssue()
                  initialContinuationRoutable = refreshed !== null && isRoutable(refreshed)
                  yield* Deferred.succeed(initialRefreshed, undefined)
                } else {
                  yield* Deferred.succeed(reloadedStarted, undefined)
                }
                return yield* Effect.never
              }),
            watchWorkflow: null,
            pollAutomatically: false,
          }
          const control = yield* startOrchestrator('/tmp/WORKFLOW.md', dependencies)

          yield* control.refresh
          yield* Deferred.await(initialStarted)
          selectedWorkflow = reloaded
          yield* control.refresh
          yield* control.snapshot
          yield* Deferred.await(reloadedStarted)
          yield* Deferred.succeed(continueInitial, undefined)
          yield* Deferred.await(initialRefreshed)
        }),
      ),
    )

    expect(trackerFactories).toEqual(['initial:initial-token', 'reloaded:reloaded-token'])
    expect(workspaceFactories).toEqual([
      'initial:/tmp/initial-workspaces:initial-hook',
      'reloaded:/tmp/reloaded-workspaces:reloaded-hook',
    ])
    expect(beforeRuns).toEqual(['initial:GH-1', 'reloaded:GH-2'])
    expect(agentRuns).toEqual([
      {
        identifier: 'GH-1',
        command: 'initial-codex app-server',
        prompt: 'Initial prompt for GH-1',
        maxTurns: 2,
        secrets: ['INITIAL_TOKEN'],
      },
      {
        identifier: 'GH-2',
        command: 'reloaded-codex app-server',
        prompt: 'Reloaded prompt for GH-2',
        maxTurns: 7,
        secrets: ['RELOADED_TOKEN'],
      },
    ])
    expect(trackerRefreshes).toContain('initial:GH-1')
    expect(trackerRefreshes).not.toContain('reloaded:GH-1')
    expect(initialContinuationRoutable).toBe(true)
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
