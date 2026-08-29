#!/usr/bin/env node
import { resolve } from 'node:path'
import { Effect } from 'effect'

import { runOrchestrator } from './orchestrator.js'

const workflowPath = resolve(process.argv[2] ?? 'WORKFLOW.md')
const controller = new AbortController()

process.once('SIGINT', () => {
  controller.abort()
})
process.once('SIGTERM', () => {
  controller.abort()
})

const exit = await Effect.runPromiseExit(runOrchestrator(workflowPath), {
  signal: controller.signal,
})

if (exit._tag === 'Failure' && !controller.signal.aborted) {
  process.stderr.write(`${String(exit.cause)}\n`)
  process.exitCode = 1
}
