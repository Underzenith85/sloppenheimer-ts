import { Effect, Layer, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import type { HooksConfig, ValidatedTrackerProvider } from '../../src/config/workflow.js'
import { issueId, issueIdentifier } from '../../src/domain/domain.js'
import { stubProvider } from '../harness/stub-tracker-provider.js'
import { WorkflowError } from '../../src/errors.js'
import {
  AgentRunner,
  codeReview,
  CodeReviewFactory,
  layerAgentRunner,
  layerCodeReviewPorts,
  layerPorts,
  layerWorkflowLoader,
  layerWorkflowWatcher,
  tracker,
  TrackerFactory,
  workspaces,
  WorkflowLoader,
  WorkflowWatcher,
  WorkspaceManagerFactory,
  type AdapterServices,
} from '../../src/ports/index.js'

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
        create: () => Effect.succeed({ path: settings.root, key: 'key', createdNow: true }),
        exists: () => Effect.succeed(false),
        beforeRun: () => Effect.void,
        afterRun: () => Effect.void,
        remove: () => Effect.void,
      }),
  }),
  layerAgentRunner({
    run: () => Effect.succeed({ threadId: 'thread', turnId: 'turn', turnCount: 1 }),
    semantics: { turnOutcome: () => 'completed' },
  }),
  layerWorkflowLoader({
    load: (path) =>
      Effect.fail(
        new WorkflowError({ category: 'missing_workflow_file', message: `no workflow: ${path}` }),
      ),
    preflight: () => Effect.succeed(validated),
  }),
  layerWorkflowWatcher({ changes: () => Effect.succeed(Stream.empty) }),
)

describe('port layer composition', (): void => {
  it('builds every port from the adapter layers and the workflow configuration', async (): Promise<void> => {
    const resolved = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const currentTracker = yield* tracker
          const currentWorkspaces = yield* workspaces
          const runner = yield* AgentRunner
          const loader = yield* WorkflowLoader
          const watcher = yield* WorkflowWatcher
          const workspace = yield* currentWorkspaces.create(issueIdentifier('example/symphony#1'))
          const result = yield* runner.run({
            issue: {
              id: issueId('1'),
              nativeRef: null,
              identifier: issueIdentifier('example/symphony#1'),
              title: 'title',
              description: null,
              priority: null,
              state: 'open',
              branchName: null,
              url: null,
              assigneeId: null,
              labels: [],
              blockedBy: [],
              dispatchable: true,
              createdAt: null,
              updatedAt: null,
            },
            workspace,
            workspaceRoot: '/workspaces',
            config: {
              command: 'codex app-server',
              approvalPolicy: 'never',
              threadSandbox: 'workspace-write',
              turnSandboxPolicy: null,
              turnTimeoutMs: 1_000,
              readTimeoutMs: 1_000,
              stallTimeoutMs: 1_000,
            },
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
            layerPorts(
              { tracker: validated, workspaces: { root: '/workspaces', hooks } },
              adapters,
            ),
          ),
        ),
      ),
    )

    expect(resolved.secretEnvironmentNames).toEqual(['GITHUB_TOKEN'])
    expect(resolved.workspacePath).toBe('/workspaces')
    expect(resolved.threadId).toBe('thread')
    expect(resolved.loadFailed).toBe(true)
  })

  it('reports the absence marker as a provider that supplies no code review', async (): Promise<void> => {
    const absent = await Effect.runPromise(
      Effect.scoped(
        codeReview.pipe(
          Effect.provide(
            layerCodeReviewPorts({
              tracker: validated,
              workspaces: { root: '/workspaces', hooks },
            }),
          ),
        ),
      ),
    )

    expect(absent).toBeNull()
  })

  it('keeps a supplied code-review factory in place of the absence marker', async (): Promise<void> => {
    const reviewed = await Effect.runPromise(
      Effect.scoped(
        codeReview.pipe(
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
                      Effect.succeed({ _tag: 'NoBranch', branchName: 'symphony/issue-1' } as const),
                    findExistingHandoff: () =>
                      Effect.succeed({ _tag: 'NoBranch', branchName: 'symphony/issue-1' } as const),
                    inspectPullRequest: () => Effect.die('unused'),
                    mergePullRequest: () => Effect.die('unused'),
                    requestPullRequestReview: () => Effect.void,
                    resolveReviewThreads: () => Effect.void,
                  }),
              }),
            ),
          ),
        ),
      ),
    )

    expect(reviewed).not.toBeNull()
  })
})
