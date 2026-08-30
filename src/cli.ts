#!/usr/bin/env node
import chokidar from 'chokidar'
import { Cause, Effect, Exit, Layer } from 'effect'

import { codexAgentRunner } from './adapters/codex/agent-runner.js'
import { makeGitHubCodeReview, makeGitHubTracker } from './adapters/github/index.js'
import { parseCliArguments, type CliOptions } from './config/cli-options.js'
import { loadWorkflow, preflightWorkflow } from './config/workflow.js'
import { startOrchestrator, type OrchestratorServices } from './core/orchestrator.js'
import type { TrackerError, WorkflowError } from './errors.js'
import { makeOperatorBackend } from './operator/operator.js'
import { startOperatorServer } from './operator/server.js'
import {
  CodeReviewFactory,
  layerAgentRunner,
  layerCodeReviewPorts,
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
import { makeWorkspaceManager } from './workspace.js'

const shutdownTimeoutMs = 10_000

/**
 * The concrete adapters this executable binds: GitHub for the tracker and for code review, Codex
 * for the agent runner, and the host filesystem for workflows and workspaces. Nothing below the
 * composition root names any of them.
 */
const adapters: Layer.Layer<AdapterServices> = Layer.mergeAll(
  layerAgentRunner(codexAgentRunner),
  Layer.succeed(TrackerFactory, {
    make: (validated) => Effect.succeed(makeGitHubTracker(validated.provider)),
  }),
  Layer.succeed(WorkspaceManagerFactory, {
    make: (settings) => Effect.succeed(makeWorkspaceManager(settings.root, settings.hooks)),
  }),
  layerWorkflowLoader({
    load: (path) => loadWorkflow(path),
    preflight: (workflow) => preflightWorkflow(workflow),
  }),
  layerWorkflowWatcher({
    watch: (path, onChange) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const watcher = chokidar.watch(path, {
            awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
            ignoreInitial: true,
          })
          watcher.on('change', onChange)
          return watcher
        }),
        (watcher) => Effect.promise(() => watcher.close()),
      ).pipe(Effect.asVoid),
  }),
)

const codeReview: Layer.Layer<CodeReviewFactory> = Layer.succeed(CodeReviewFactory, {
  make: (validated) => Effect.succeed(makeGitHubCodeReview(validated.provider)),
})

/**
 * The production layer. The first instance of each rebuildable port is built from the workflow as
 * it stands at startup; every later reload and credential rotation replaces it through its cell.
 */
const ports = (
  workflowPath: string,
): Layer.Layer<OrchestratorServices | CodeReviewServices, WorkflowError | TrackerError> =>
  Layer.unwrapEffect(
    loadWorkflow(workflowPath).pipe(
      Effect.map((workflow) => {
        const configuration = portsConfiguration(workflow)
        return Layer.merge(
          layerPorts(configuration, adapters),
          layerCodeReviewPorts(configuration, codeReview),
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

  const program = Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* startOrchestrator(options.workflowPath)
      yield* logInfo('symphony host started', { workflow_path: options.workflowPath })
      const loader = yield* WorkflowLoader
      const workflow = yield* loader.load(options.workflowPath)
      const port = options.port ?? workflow.config.serverPort
      if (port !== null) {
        const server = yield* startOperatorServer(
          port,
          makeOperatorBackend(options.workflowPath, orchestrator),
        )
        yield* logInfo('operator console listening', { url: server.url })
      }
      return yield* orchestrator.awaitTermination
    }),
    // Provided around the whole program, not around the start: the cells the orchestrator rebuilds
    // through live as long as the host does.
  ).pipe(Effect.provide(ports(options.workflowPath)))

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
