import { resolve } from 'node:path'
import { Effect, type Scope } from 'effect'

import type { WorkflowError } from '../errors.js'
import {
  runOrchestratorRuntime,
  startOrchestratorRuntime,
  type OrchestratorControl,
  type OrchestratorDependencies,
} from './runtime.js'

export {
  issueIsRoutable,
  retainedCompletedDetails,
  retryDelayMs,
  sortIssues,
  type AgentDetailLookup,
  type OrchestratorControl,
  type OrchestratorContext,
  type OrchestratorDependencies,
  type OrchestratorSnapshot,
  type RetrySnapshot,
  type RunningSnapshot,
} from './runtime.js'

export const startOrchestrator = (
  selectedWorkflowPath = resolve(process.cwd(), 'WORKFLOW.md'),
  dependencies?: OrchestratorDependencies,
): Effect.Effect<OrchestratorControl, WorkflowError, Scope.Scope> =>
  dependencies === undefined
    ? startOrchestratorRuntime(selectedWorkflowPath)
    : startOrchestratorRuntime(selectedWorkflowPath, dependencies)

export const runOrchestrator = (
  selectedWorkflowPath = resolve(process.cwd(), 'WORKFLOW.md'),
): Effect.Effect<void, WorkflowError> => runOrchestratorRuntime(selectedWorkflowPath)
