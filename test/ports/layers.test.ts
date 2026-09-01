import { it } from '@effect/vitest'
import { Effect, Layer, Option, Stream } from 'effect'
import { describe, expect } from 'vitest'

import type { HooksConfig, ValidatedTrackerProvider } from '@sloppenheimer/core/config/workflow.js'
import { issueId, issueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import { stubProvider } from '../harness/stub-tracker-provider.js'
import { WorkflowError } from '@sloppenheimer/core/domain/errors.js'
import {
  AgentRunner,
  codeReview,
  CodeReviewFactory,
  SourceControlFactory,
  layerAgentRunner,
  layerCodeReviewPorts,
  layerSourceControlPorts,
  layerPorts,
  layerWorkflowLoader,
  layerWorkflowWatcher,
  tracker,
  sourceControl,
  TrackerFactory,
  workspaces,
  WorkflowLoader,
  WorkflowWatcher,
  WorkspaceManagerFactory,
  type AdapterServices,
} from '@sloppenheimer/core'
import { codexRunnerConfig } from '../harness/codex-runner-config.js'
import { auroraRunner } from '../harness/alien-agent-runner.js'
import { anIssue } from '../harness/fixtures.js'

const hooks: HooksConfig = {
  afterCreate: null,
  beforeRun: null,
  afterRun: null,
  beforeRemove: null,
  timeoutMs: 1_000,
}

const validated: ValidatedTrackerProvider = stubProvider('token')

/** Stand-ins for the adapter layers the adapter issues supply. */
const adapters: Layer.Layer<AdapterServices> = Layer.mergeAll(
  Layer.succeed(TrackerFactory, {
    make: () =>
      Effect.succeed({
        fetchIssuesByStates: () => Effect.succeed([]),
        fetchIssuesByIds: () => Effect.succeed([]),
        toolSpecs: [],
        executeTool: () => Promise.resolve({ success: true, data: null }),
        secretEnvironmentNames: ['GITHUB_TOKEN'],
      }),
  }),
  Layer.succeed(WorkspaceManagerFactory, {
    make: (settings) =>
      Effect.succeed({
        withLeasedWorkspace: (_run, use) => use({ path: settings.root, key: 'key' }),
        exists: () => Effect.succeed(false),
        beforeRun: () => Effect.void,
        afterRun: () => Effect.void,
        remove: () => Effect.void,
      }),
  }),
  layerAgentRunner({
    kind: 'stub',
    run: () => Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
  }),
  layerWorkflowLoader({
    load: (path) =>
      Effect.fail(
        new WorkflowError({ category: 'missing_workflow_file', message: `no workflow: ${path}` }),
      ),
    preflight: () => Effect.succeed({ tracker: validated, runner: auroraRunner() }),
  }),
  layerWorkflowWatcher({ changes: () => Effect.succeed(Stream.empty) }),
)

describe('port layer composition', (): void => {
  it.scoped('builds every port from the adapter layers and the workflow configuration', () =>
    Effect.gen(function* () {
      const resolved = yield* Effect.gen(function* () {
        const currentTracker = yield* tracker
        const currentWorkspaces = yield* workspaces
        const runner = yield* AgentRunner
        const loader = yield* WorkflowLoader
        const watcher = yield* WorkflowWatcher
        const workspace = yield* currentWorkspaces.withLeasedWorkspace(
          {
            identifier: issueIdentifier('example/sloppenheimer#1'),
            runId: 1,
          },
          (leased) => Effect.succeed(leased),
          () => ({ _tag: 'Completed' }),
        )
        const result = yield* runner.run({
          issue: anIssue({
            id: issueId('1'),
            identifier: issueIdentifier('example/sloppenheimer#1'),
            title: 'title',
            labels: [],
          }),
          workspace,
          workspaceRoot: '/workspaces',
          config: codexRunnerConfig({
            command: 'codex app-server',
            turnTimeoutMs: 1_000,
            readTimeoutMs: 1_000,
            stallTimeoutMs: 1_000,
          }),
          prompt: 'prompt',
          maxTurns: 1,
          secretEnvironmentNames: [],
          refreshIssue: () => Effect.succeed(null),
          isRoutable: () => true,
          onEvent: () => {},
        })
        yield* Stream.runDrain(yield* watcher.changes('WORKFLOW.md'))
        const loadFailed = yield* Effect.isFailure(loader.load('WORKFLOW.md'))
        return {
          secretEnvironmentNames: currentTracker.secretEnvironmentNames,
          workspacePath: workspace.path,
          threadId: result.threadId,
          loadFailed,
        }
      }).pipe(
        Effect.provide(
          layerPorts({ tracker: validated, workspaces: { root: '/workspaces', hooks } }, adapters),
        ),
      )

      expect(resolved.secretEnvironmentNames).toEqual(['GITHUB_TOKEN'])
      expect(resolved.workspacePath).toBe('/workspaces')
      expect(resolved.threadId).toBe('thread')
      expect(resolved.loadFailed).toBe(true)
    }),
  )

  it.scoped('reports the absence marker as a provider that supplies no code review', () =>
    Effect.gen(function* () {
      const absent = yield* codeReview

      expect(absent).toBeNull()
    }).pipe(
      Effect.provide(
        layerCodeReviewPorts({ tracker: validated, workspaces: { root: '/workspaces', hooks } }),
      ),
    ),
  )

  it.effect('composes source control independently from tracker and code review', () =>
    Effect.gen(function* () {
      const absent = yield* sourceControl.pipe(
        Effect.scoped,
        Effect.provide(
          layerSourceControlPorts({
            tracker: validated,
            workspaces: { root: '/workspaces', hooks },
          }),
        ),
      )
      expect(absent).toBeNull()

      const supplied = yield* sourceControl.pipe(
        Effect.scoped,
        Effect.provide(
          layerSourceControlPorts(
            { tracker: validated, workspaces: { root: '/workspaces', hooks } },
            Layer.succeed(SourceControlFactory, {
              make: () =>
                Effect.succeed({
                  prepare: (_issue, workspace, target) =>
                    Effect.succeed({
                      workspace,
                      target,
                      baseBranch: 'main',
                      baseSha: 'base',
                      baselineSha: 'base',
                      expectedRemoteHead: Option.none(),
                    }),
                  publish: (_issue, prepared) =>
                    Effect.succeed({
                      _tag: 'NoChanges',
                      branchName: prepared.target.branchName,
                      baselineSha: prepared.baselineSha,
                    }),
                }),
            }),
          ),
        ),
      )
      expect(supplied).not.toBeNull()
    }),
  )

  it.scoped('keeps a supplied code-review factory in place of the absence marker', () =>
    Effect.gen(function* () {
      const reviewed = yield* codeReview

      expect(reviewed).not.toBeNull()
    }).pipe(
      Effect.provide(
        layerCodeReviewPorts(
          { tracker: validated, workspaces: { root: '/workspaces', hooks } },
          Layer.succeed(CodeReviewFactory, {
            make: () =>
              Effect.succeed({
                toolSpecs: [],
                executeTool: async (name) => ({
                  success: false,
                  error: {
                    code: 'unsupported_tool' as const,
                    message: `Unsupported host tool: ${name}`,
                    retryable: false,
                  },
                }),
                handoffCompletedWork: () =>
                  Effect.succeed({
                    _tag: 'NoBranch',
                    branchName: 'sloppenheimer/issue-1',
                  } as const),
                findExistingHandoff: () =>
                  Effect.succeed({
                    _tag: 'NoBranch',
                    branchName: 'sloppenheimer/issue-1',
                  } as const),
                inspectPullRequest: () => Effect.die('unused'),
                mergePullRequest: () => Effect.die('unused'),
                requestPullRequestReview: () => Effect.void,
                resolveReviewThreads: () => Effect.void,
              }),
          }),
        ),
      ),
    ),
  )
})
