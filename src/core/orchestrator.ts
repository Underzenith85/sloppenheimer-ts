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
  type WorkflowWatcher,
} from './runtime.js'

export const startOrchestrator = (
  selectedWorkflowPath: string,
  dependencies: OrchestratorDependencies,
): Effect.Effect<OrchestratorControl, WorkflowError, Scope.Scope> =>
  startOrchestratorRuntime(selectedWorkflowPath, dependencies)

export const runOrchestrator = (
  selectedWorkflowPath: string,
  dependencies: OrchestratorDependencies,
): Effect.Effect<void, WorkflowError> => runOrchestratorRuntime(selectedWorkflowPath, dependencies)
