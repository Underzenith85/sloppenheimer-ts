import { resolve } from 'node:path'
import chokidar from 'chokidar'
import type { Effect, Scope } from 'effect'

import { codexAgentEventSemantics, codexAgentRunner } from './adapters/codex/agent-runner.js'
import { loadWorkflow } from './config/workflow.js'
import {
  runOrchestrator as runOrchestratorCore,
  startOrchestrator as startOrchestratorCore,
  type OrchestratorControl,
  type OrchestratorDependencies,
} from './core/orchestrator.js'
import type { WorkflowError } from './errors.js'
import { makeGitHubCodeReview, makeGitHubTracker } from './tracker.js'
import { makeWorkspaceManager } from './adapters/node/workspace-manager.js'

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
} from './core/orchestrator.js'

/**
 * The composition root binds the concrete adapters.  `src/core` depends on these only through
 * `OrchestratorDependencies`, so the core runtime never imports an adapter implementation.
 */
const defaultDependencies: OrchestratorDependencies = {
  loadWorkflow,
  makeTracker: (workflow) => makeGitHubTracker(workflow.tracker.provider),
  makeCodeReview: (workflow) => makeGitHubCodeReview(workflow.tracker.provider),
  makeWorkspaces: (workflow) =>
    makeWorkspaceManager(workflow.config.workspaceRoot, workflow.config.hooks),
  runAgent: codexAgentRunner.run,
  agentEventSemantics: codexAgentEventSemantics,
  watchWorkflow: (path, onChange) => {
    const watcher = chokidar.watch(path, {
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      ignoreInitial: true,
    })
    watcher.on('change', onChange)
    return watcher
  },
  environment: process.env,
}

export const startOrchestrator = (
  selectedWorkflowPath = resolve(process.cwd(), 'WORKFLOW.md'),
  dependencies: OrchestratorDependencies = defaultDependencies,
): Effect.Effect<OrchestratorControl, WorkflowError, Scope.Scope> =>
  startOrchestratorCore(selectedWorkflowPath, dependencies)

export const runOrchestrator = (
  selectedWorkflowPath = resolve(process.cwd(), 'WORKFLOW.md'),
): Effect.Effect<void, WorkflowError> =>
  runOrchestratorCore(selectedWorkflowPath, defaultDependencies)
