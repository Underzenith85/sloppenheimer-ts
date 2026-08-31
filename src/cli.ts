#!/usr/bin/env node
import chokidar from 'chokidar'
import { Cause, ConfigProvider, Effect, Exit, Layer, Queue, Stream } from 'effect'

import { codexAgentRunner } from './adapters/codex/agent-runner.js'
import {
  githubHttpClientLayer,
  githubProviderOf,
  layerGitHubIssueControl,
  makeGitHubCodeReview,
  makeGitHubTracker,
} from './adapters/github/index.js'
import { makeWorkspaceManager } from './adapters/node/workspace-manager.js'
import { parseCliArguments, type CliOptions } from './config/cli-options.js'
import { loadWorkflow, preflightWorkflow } from './config/workflow.js'
import { trackerProviders } from './tracker-adapters.js'
import { startOrchestrator, type OrchestratorServices } from './core/orchestrator.js'
import { TrackerError, type WorkflowError } from './errors.js'
import { makeOperatorBackend } from './operator/operator.js'
import { startOperatorServer } from './operator/server.js'
import {
  CodeReviewFactory,
  CurrentIssueControl,
  layerAgentRunner,
  layerCodeReviewPorts,
  layerCurrentIssueControl,
  layerPorts,
  layerWorkflowLoader,
  layerWorkflowWatcher,
  portsConfiguration,
  TrackerFactory,
  WorkflowLoader,
  WorkspaceManagerFactory,
  type AdapterServices,
  type CodeReviewServices,
} from './ports/index.js'
import { logInfo } from './support/logging.js'

/**
 * The CLI's last-resort bound. Cleanup is not allowed to depend on it: the host closes its scope
 * with parallel finalizers, so the wall-clock cost of shutdown is the slowest single finaliser
 * rather than the sum of one per active worker. This watchdog exists only for a finaliser that
 * never settles at all.
 */
const shutdownTimeoutMs = 10_000

/**
 * What an operator is owed when a workflow names a kind `trackerProviders` validates but this
 * executable has no ports for. Reading the selection back through the GitHub adapter throws, and
 * these factories build their instance eagerly, so the throw is caught here and reported as a
 * typed failure the orchestrator can surface rather than a defect that takes the host down.
 */
const boundToGitHub =
  (kind: string) =>
  (cause: unknown): TrackerError =>
    new TrackerError({
      category: 'unsupported_tracker_kind',
      message: `tracker.kind ${kind} is validated but this build binds its ports to github only`,
      retryable: false,
      cause,
    })

/**
 * The concrete adapters this executable binds: GitHub for the tracker and for code review, Codex
 * for the agent runner, and the host filesystem for workflows and workspaces. Nothing below the
 * composition root names any of them.
 */
const adapters: Layer.Layer<AdapterServices> = Layer.mergeAll(
  layerAgentRunner(codexAgentRunner),
  Layer.succeed(TrackerFactory, {
    make: (validated) =>
      Effect.try({
        try: () => makeGitHubTracker(githubProviderOf(validated)),
        catch: boundToGitHub(validated.kind),
      }),
  }),
  Layer.succeed(WorkspaceManagerFactory, {
    make: (settings) => Effect.succeed(makeWorkspaceManager(settings.root, settings.hooks)),
  }),
  layerWorkflowLoader({
    load: (path) => loadWorkflow(path, trackerProviders),
    preflight: (workflow) => preflightWorkflow(workflow),
  }),
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

const codeReview: Layer.Layer<CodeReviewFactory> = Layer.succeed(CodeReviewFactory, {
  make: (validated) =>
    Effect.try({
      try: () => makeGitHubCodeReview(githubProviderOf(validated)),
      catch: boundToGitHub(validated.kind),
    }),
})

/** The console's issue surface, bound to GitHub here so `operator/` never names an adapter. */
const issueControl: Layer.Layer<CurrentIssueControl> = layerCurrentIssueControl.pipe(
  Layer.provide(layerGitHubIssueControl),
)

/**
 * The production layer. The first instance of each rebuildable port is built from the workflow as
 * it stands at startup; every later reload and credential rotation replaces it through its cell.
 */
const ports = (
  workflowPath: string,
): Layer.Layer<
  OrchestratorServices | CodeReviewServices | CurrentIssueControl,
  WorkflowError | TrackerError
> =>
  Layer.unwrapEffect(
    loadWorkflow(workflowPath, trackerProviders).pipe(
      Effect.map((workflow) => {
        const configuration = portsConfiguration(workflow)
        return Layer.mergeAll(
          layerPorts(configuration, adapters),
          layerCodeReviewPorts(configuration, codeReview),
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
