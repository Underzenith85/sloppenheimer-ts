#!/usr/bin/env node
import { Effect } from 'effect'

import { parseCliArguments } from './cli-options.js'
import { logInfo } from './logging.js'
import { makeOperatorBackend } from './operator.js'
import { startOrchestrator } from './orchestrator.js'
import { startOperatorServer } from './server.js'
import { loadWorkflow } from './workflow.js'

const options = parseCliArguments(process.argv.slice(2))
const controller = new AbortController()

process.once('SIGINT', () => {
  controller.abort()
})
process.once('SIGTERM', () => {
  controller.abort()
})

const program = Effect.scoped(
  Effect.gen(function* () {
    const orchestrator = yield* startOrchestrator(options.workflowPath)
    const workflow = yield* loadWorkflow(options.workflowPath)
    const port = options.port ?? workflow.config.serverPort
    if (port !== null) {
      const server = yield* startOperatorServer(
        port,
        makeOperatorBackend(options.workflowPath, orchestrator),
      )
      yield* logInfo('operator console listening', { url: server.url })
    }
    return yield* Effect.never
  }),
)

const exit = await Effect.runPromiseExit(program, {
  signal: controller.signal,
})

if (exit._tag === 'Failure' && !controller.signal.aborted) {
  process.stderr.write(`${String(exit.cause)}\n`)
  process.exitCode = 1
}
