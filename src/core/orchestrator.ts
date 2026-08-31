import { Effect, type Scope } from 'effect'

import type { WorkflowError } from '../errors.js'
import {
  runOrchestratorRuntime,
  startOrchestratorRuntime,
  type OrchestratorControl,
  type OrchestratorServices,
} from './runtime.js'

export {
  issueIsRoutable,
  retainedCompletedDetails,
  retryDelayMs,
  sortIssues,
  type AgentDetailLookup,
  type OrchestratorContext,
  type OrchestratorControl,
  type OrchestratorServices,
  type OrchestratorSnapshot,
  type RetrySnapshot,
  type RunningSnapshot,
  type RuntimePorts,
} from './runtime.js'

export const startOrchestrator = (
  selectedWorkflowPath: string,
): Effect.Effect<OrchestratorControl, WorkflowError, OrchestratorServices | Scope.Scope> =>
  startOrchestratorRuntime(selectedWorkflowPath)

export const runOrchestrator = (
  selectedWorkflowPath: string,
): Effect.Effect<void, WorkflowError, OrchestratorServices> =>
  runOrchestratorRuntime(selectedWorkflowPath)
