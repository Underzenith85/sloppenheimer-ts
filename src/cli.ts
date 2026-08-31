#!/usr/bin/env node
import chokidar from 'chokidar'
import { Cause, Effect, Exit, Layer, Stream } from 'effect'

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
    load: (path) => loadWorkflow(path, process.env, trackerProviders),
    preflight: (workflow) => preflightWorkflow(workflow),
  }),
  layerWorkflowWatcher({
    // `asyncPush` is the adapter for a push-based source: chokidar's callback only offers into the
    // stream's buffer, and the runtime is entered on the consuming fiber instead. The buffer is
    // unbounded because a dropped change is a reload that never happens.
    changes: (path) =>
      Stream.asyncPush<void>(
        (emit) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const watcher = chokidar.watch(path, {
                awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
                ignoreInitial: true,
              })
              watcher.on('change', () => {
                emit.single(undefined)
              })
              return watcher
            }),
            (watcher) => Effect.promise(() => watcher.close()),
          ),
        { bufferSize: 'unbounded' },
      ),
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
    loadWorkflow(workflowPath, process.env, trackerProviders).pipe(
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
    // Provided around the whole program, not around the start: the cells the orchestrator rebuilds
    // through live as long as the host does. The GitHub adapter reads its HTTP transport from the
    // same context, so the client bound here reaches every request its ports make.
  ).pipe(Effect.provide(ports(options.workflowPath)), Effect.provide(githubHttpClientLayer))

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
