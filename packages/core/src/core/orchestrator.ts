import { Effect, type Scope } from 'effect'

import type { WorkflowError } from '../domain/errors.js'
import {
  runOrchestratorRuntime,
  startOrchestratorRuntime,
  type OrchestratorControl,
  type OrchestratorServices,
} from './runtime.js'

export {
  issueIsRoutable,
  retainedCompletedDetails,
  sortIssues,
  type AgentDetailLookup,
  type CompletedSnapshot,
  type OrchestratorContext,
  type OrchestratorControl,
  type OrchestratorServices,
  type OrchestratorSnapshot,
  type RefreshOperation,
  type RefreshOutcome,
  type RetrySnapshot,
  type RunningSnapshot,
  type RuntimePorts,
  type TracePage,
  type TraceQuery,
  type TraceRecorder,
  tracePageLimit,
  traceQuery,
} from './runtime.js'

export const startOrchestrator = (
  selectedWorkflowPath: string,
): Effect.Effect<OrchestratorControl, WorkflowError, OrchestratorServices | Scope.Scope> =>
  startOrchestratorRuntime(selectedWorkflowPath)

export const runOrchestrator = (
  selectedWorkflowPath: string,
): Effect.Effect<void, WorkflowError, OrchestratorServices> =>
  runOrchestratorRuntime(selectedWorkflowPath)
