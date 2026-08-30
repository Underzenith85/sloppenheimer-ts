#!/usr/bin/env node
import { Cause, Effect, Exit } from 'effect'

import { parseCliArguments, type CliOptions } from './cli-options.js'
import { logInfo } from './logging.js'
import { makeOperatorBackend } from './operator.js'
import { startOrchestrator } from './orchestrator.js'
import { startOperatorServer } from './server.js'
import { loadWorkflow } from './workflow.js'

const shutdownTimeoutMs = 10_000

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
      const workflow = yield* loadWorkflow(options.workflowPath)
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
