#!/usr/bin/env node
import { FileSystem } from '@effect/platform'
import { NodeFileSystem } from '@effect/platform-node'
import { Cause, ConfigProvider, Effect, Exit, Layer } from 'effect'

import { githubHttpClientLayer } from '@sloppenheimer/adapter-github'
import { parseCliArguments, type CliOptions } from './config/cli-options.js'
import { applicationPorts } from './composition.js'
import { makeOperatorBackend } from './operator/operator.js'
import { startOperatorServer } from './operator/server.js'
import { startOrchestrator, WorkflowLoader } from '@sloppenheimer/core'
import { logInfo } from '@sloppenheimer/core/support/logging.js'
import { withProtectedTracer } from '@sloppenheimer/core/support/observability.js'

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

const messageFrom = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message
  }
  return String(cause)
}

const reportFailure = (cause: unknown): void => {
  process.stderr.write(`sloppenheimer: ${messageFrom(cause)}\n`)
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
        yield* logInfo('sloppenheimer host started', { workflow_path: options.workflowPath })
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
    Effect.provide(applicationPorts(options.workflowPath)),
    Effect.provide(hostFileSystem),
    Effect.provide(githubHttpClientLayer),
    // The composition root states where configuration comes from. Everything below reads the
    // environment as a `Config` against whatever provider the fiber carries, so this is the one
    // place that says "the process environment" — and the one line a test replaces.
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    // Exporters are a composition-root concern. This guard keeps a broken one supplemental.
    withProtectedTracer,
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
