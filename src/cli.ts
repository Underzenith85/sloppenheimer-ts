#!/usr/bin/env node
import { FileSystem } from '@effect/platform'
import { NodeFileSystem } from '@effect/platform-node'
import chokidar from 'chokidar'
import { Cause, ConfigProvider, Effect, Exit, Layer, Queue, Stream } from 'effect'

import { layerCodexAgentRunner } from '@symphony/adapter-codex'
import { githubHttpClientLayer } from '@symphony/adapter-github'
import { makeWorkspaceManager } from '@symphony/adapter-node'
import { parseCliArguments, type CliOptions } from './config/cli-options.js'
import { loadWorkflow, preflightWorkflow } from './config/workflow.js'
import {
  codeReviewFactory,
  issueControlFactory,
  sourceControlFactory,
  trackerFactory,
  trackerProviders,
} from './tracker-adapters.js'
import {
  SourceControlError,
  TrackerError,
  type WorkflowError,
} from '@symphony/core/domain/errors.js'
import { makeOperatorBackend } from './operator/operator.js'
import { startOperatorServer } from './operator/server.js'
import {
  CodeReviewFactory,
  CurrentIssueControl,
  IssueControlFactory,
  layerCodeReviewPorts,
  layerSourceControlPorts,
  layerCurrentIssueControl,
  layerPorts,
  layerWorkflowWatcher,
  portsConfiguration,
  startOrchestrator,
  TrackerFactory,
  SourceControlFactory,
  WorkflowLoader,
  WorkspaceManagerFactory,
  type AdapterServices,
  type CodeReviewServices,
  type PortServices,
  type SourceControlServices,
} from '@symphony/core'
import { logInfo } from '@symphony/core/support/logging.js'

/**
 * The CLI's last-resort bound. Cleanup is not allowed to depend on it: the host closes its scope
 * with parallel finalizers, so the wall-clock cost of shutdown is the slowest single finaliser
 * rather than the sum of one per active worker. This watchdog exists only for a finaliser that
 * never settles at all.
 */
const shutdownTimeoutMs = 10_000

/**
 * The host filesystem, named in one place. Every module below reads and writes through the
 * `FileSystem` service, so this is the only line that says which filesystem that is — and the one
 * line a test replaces.
 */
const hostFileSystem: Layer.Layer<FileSystem.FileSystem> = NodeFileSystem.layer

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
 */
const ports = (
  workflowPath: string,
): Layer.Layer<
  PortServices | CodeReviewServices | SourceControlServices | CurrentIssueControl,
  WorkflowError | TrackerError | SourceControlError,
  FileSystem.FileSystem
> =>
  Layer.unwrapEffect(
    loadWorkflow(workflowPath, trackerProviders).pipe(
      Effect.map((workflow) => {
        const configuration = portsConfiguration(workflow)
        return Layer.mergeAll(
          layerPorts(configuration, adapters),
          layerCodeReviewPorts(configuration, codeReview),
          layerSourceControlPorts(configuration, sourceControl),
          issueControl,
        )
      }),
    ),
  )

const messageFrom = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message
  }
  return String(cause)
}

const reportFailure = (cause: unknown): void => {
  process.stderr.write(`symphony: ${messageFrom(cause)}\n`)
}

const main = async (): Promise<number> => {
  let options: CliOptions
  try {
    options = parseCliArguments(process.argv.slice(2))
  } catch (cause: unknown) {
    reportFailure(cause)
    return 1
  }

  const controller = new AbortController()
  let shutdownTimer: NodeJS.Timeout | undefined
  const requestShutdown = (): void => {
    if (controller.signal.aborted) {
      return
    }
    controller.abort()
    shutdownTimer = setTimeout(() => {
      reportFailure(new Error(`shutdown did not complete within ${String(shutdownTimeoutMs)}ms`))
      process.exit(1)
    }, shutdownTimeoutMs)
  }
  process.once('SIGINT', requestShutdown)
  process.once('SIGTERM', requestShutdown)

  /**
   * The composition root binds the HTTP transport the GitHub adapter talks through. The adapter
   * falls back to this same layer when it is run without one, so a test can substitute a client.
   */
  const program = Effect.scoped(
    /**
     * Finalizers of the host scope run concurrently. The orchestrator forks one fiber per active
     * worker into this scope, and interrupting a worker waits on the Codex App Server's bounded
     * `SIGTERM` grace and post-`SIGKILL` reap. Sequentially — the Effect default — that cost is
     * multiplied by `agent.max_concurrent_agents` and overruns the watchdog; run in parallel it is
     * paid once, so the operator listener is released and the host exits within the deadline
     * whatever the concurrency limit is set to.
     */
    Effect.parallelFinalizers(
      Effect.gen(function* () {
        const orchestrator = yield* startOrchestrator(options.workflowPath)
        yield* logInfo('symphony host started', { workflow_path: options.workflowPath })
        const loader = yield* WorkflowLoader
        const workflow = yield* loader.load(options.workflowPath)
        const port = options.port ?? workflow.config.serverPort
        if (port !== null) {
          const backend = yield* makeOperatorBackend(options.workflowPath, orchestrator)
          const server = yield* startOperatorServer(port, backend)
          yield* logInfo('operator console listening', { url: server.url })
        }
        return yield* orchestrator.awaitTermination
      }),
    ),
    // Provided around the whole program, not around the start: the cells the orchestrator rebuilds
    // through live as long as the host does. The GitHub adapter reads its HTTP transport from the
    // same context, so the client bound here reaches every request its ports make.
  ).pipe(
    Effect.provide(ports(options.workflowPath)),
    Effect.provide(hostFileSystem),
    Effect.provide(githubHttpClientLayer),
    // The composition root states where configuration comes from. Everything below reads the
    // environment as a `Config` against whatever provider the fiber carries, so this is the one
    // place that says "the process environment" — and the one line a test replaces.
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
  )

  const exit = await Effect.runPromiseExit(program, {
    signal: controller.signal,
  })

  if (shutdownTimer !== undefined) {
    clearTimeout(shutdownTimer)
  }
  process.removeListener('SIGINT', requestShutdown)
  process.removeListener('SIGTERM', requestShutdown)

  if (Exit.isFailure(exit)) {
    if (controller.signal.aborted && Cause.isInterruptedOnly(exit.cause)) {
      return 0
    }
    reportFailure(Cause.squash(exit.cause))
    return 1
  }
  return 0
}

process.exitCode = await main()
