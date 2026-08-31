import { FileSystem } from '@effect/platform'
import chokidar from 'chokidar'
import { Effect, Layer, Queue, Stream } from 'effect'

import { layerCodexAgentRunner } from '@symphony/adapter-codex'
import { makeWorkspaceManager } from '@symphony/adapter-node'
import { loadWorkflow, preflightWorkflow } from './config/workflow.js'
import {
  codeReviewFactory,
  issueControlFactory,
  sourceControlFactory,
  trackerFactory,
  trackerProviders,
} from './tracker-adapters.js'
import type {
  SourceControlError,
  TrackerError,
  WorkflowError,
} from '@symphony/core/domain/errors.js'
import {
  CodeReviewFactory,
  CurrentIssueControl,
  IssueControlFactory,
  layerCodeReviewPorts,
  layerCurrentIssueControl,
  layerPorts,
  layerSourceControlPorts,
  layerWorkflowWatcher,
  portsConfiguration,
  SourceControlFactory,
  TrackerFactory,
  WorkflowLoader,
  WorkspaceManagerFactory,
  type AdapterServices,
  type PortServices,
  type SourceControlServices,
} from '@symphony/core'

/**
 * The concrete adapters this executable binds: GitHub for the tracker and for code review, Codex
 * for the agent runner, and the host filesystem for workflows and workspaces. Nothing below the
 * composition root names any of them.
 *
 * The workflow loader, the workspace manager and the agent runner are built against the filesystem
 * rather than carrying the requirement in their ports: each binds it once here, so a port a reload
 * rebuilds stays an ordinary effect at every call site below.
 */
const adapters: Layer.Layer<AdapterServices, never, FileSystem.FileSystem> = Layer.mergeAll(
  layerCodexAgentRunner,
  Layer.succeed(TrackerFactory, trackerFactory),
  Layer.effect(
    WorkspaceManagerFactory,
    Effect.map(FileSystem.FileSystem, (fileSystem) => ({
      make: (settings) =>
        makeWorkspaceManager(settings.root, settings.hooks).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        ),
    })),
  ),
  Layer.effect(
    WorkflowLoader,
    Effect.map(FileSystem.FileSystem, (fileSystem) => ({
      load: (path) =>
        loadWorkflow(path, trackerProviders).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        ),
      preflight: (workflow) => preflightWorkflow(workflow),
    })),
  ),
  layerWorkflowWatcher({
    // The queue is what turns chokidar's callback into a stream: `unsafeOffer` is a write to a data
    // structure rather than an entry into the runtime, and the consuming fiber is where the change
    // becomes an effect. It is unbounded because a dropped change is a reload that never happens.
    //
    // Both resources are acquired here rather than inside a stream the consumer starts later, so
    // chokidar is installed before startup continues and an edit that lands before the orchestrator
    // subscribes waits in the queue.
    changes: (path) =>
      Effect.gen(function* () {
        const changes = yield* Effect.acquireRelease(Queue.unbounded<void>(), (queue) =>
          Queue.shutdown(queue),
        )
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const watcher = chokidar.watch(path, {
              awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
              ignoreInitial: true,
            })
            watcher.on('change', () => {
              Queue.unsafeOffer(changes, undefined)
            })
            return watcher
          }),
          (watcher) => Effect.promise(() => watcher.close()),
        )
        return Stream.fromQueue(changes)
      }),
  }),
)

const codeReview: Layer.Layer<CodeReviewFactory> = Layer.succeed(
  CodeReviewFactory,
  codeReviewFactory,
)

const sourceControl: Layer.Layer<SourceControlFactory> = Layer.succeed(
  SourceControlFactory,
  sourceControlFactory,
)

/** The console's issue surface, selected from the same provider registry as the tracker. */
const issueControl: Layer.Layer<CurrentIssueControl> = layerCurrentIssueControl.pipe(
  Layer.provide(Layer.succeed(IssueControlFactory, issueControlFactory)),
)

/**
 * The production layer. The first instance of each rebuildable port is built from the workflow as
 * it stands at startup; every later reload and credential rotation replaces it through its cell.
 *
 * `handoff.enabled` is answered here and nowhere else. Composing the code-review services enables
 * the pull-request handoff extension, and composing none of them disables it: the orchestrator
 * reads that structurally rather than reading the key, so the disabled build follows the core
 * continuation lifecycle and never reads the handoff store. Source control is composed either way —
 * preparing and publishing a branch is a capability of its own, not part of the extension.
 *
 * Because the answer is given once, when the process starts, a workflow that changes the key takes
 * effect on the next start rather than on a reload.
 */
export const applicationPorts = (
  workflowPath: string,
): Layer.Layer<
  PortServices | SourceControlServices | CurrentIssueControl,
  WorkflowError | TrackerError | SourceControlError,
  FileSystem.FileSystem
> =>
  Layer.unwrapEffect(
    loadWorkflow(workflowPath, trackerProviders).pipe(
      Effect.map((workflow) => {
        const configuration = portsConfiguration(workflow)
        const base = Layer.mergeAll(
          layerPorts(configuration, adapters),
          layerSourceControlPorts(configuration, sourceControl),
          issueControl,
        )
        return workflow.config.handoffEnabled
          ? Layer.merge(base, layerCodeReviewPorts(configuration, codeReview))
          : base
      }),
    ),
  )
