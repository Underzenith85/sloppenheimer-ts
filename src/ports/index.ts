import { Layer } from 'effect'

import type { Workflow } from '../config/workflow.js'
import type { TrackerError } from '../errors.js'
import { AgentRunner } from './agent-runner.js'
import { CodeReviewFactory, CurrentCodeReview, layerCurrentCodeReview } from './code-review.js'
import { CurrentTracker, layerCurrentTracker, TrackerFactory } from './tracker.js'
import { WorkflowLoader, WorkflowWatcher } from './workflow.js'
import {
  CurrentWorkspaceManager,
  layerCurrentWorkspaceManager,
  WorkspaceManagerFactory,
  type WorkspaceSettings,
} from './workspace.js'

export { makeAdapterCell, type AdapterCell, type AdapterRebuild } from './cell.js'
export {
  AgentRunner,
  layerAgentRunner,
  type AgentLaunch,
  type AgentResult,
  type AgentRunnerConfig,
  type AgentRunnerPort,
} from './agent-runner.js'
export {
  codeReview,
  CodeReviewFactory,
  CurrentCodeReview,
  layerCurrentCodeReview,
  type CodeReviewCell,
  type CodeReviewFactoryPort,
  type CodeReviewPort,
  type HandoffResult,
} from './code-review.js'
export {
  CurrentTracker,
  layerCurrentTracker,
  tracker,
  TrackerFactory,
  type IssueFetchOptions,
  type TrackerCell,
  type TrackerFactoryPort,
  type TrackerPort,
} from './tracker.js'
export {
  layerWorkflowLoader,
  layerWorkflowWatcher,
  WorkflowLoader,
  WorkflowWatcher,
  type WorkflowLoaderPort,
  type WorkflowWatcherPort,
} from './workflow.js'
export {
  CurrentWorkspaceManager,
  layerCurrentWorkspaceManager,
  WorkspaceManagerFactory,
  workspaces,
  type WorkspaceManagerCell,
  type WorkspaceManagerFactoryPort,
  type WorkspaceManagerPort,
  type WorkspaceSettings,
} from './workspace.js'

/** What the adapters supply: the two singletons and the three factories the cells build from. */
export type AdapterServices =
  | AgentRunner
  | CodeReviewFactory
  | TrackerFactory
  | WorkflowLoader
  | WorkflowWatcher
  | WorkspaceManagerFactory

/** What the orchestrator consumes: the adapter services plus the rebuildable instances. */
export type PortServices =
  | AdapterServices
  | CurrentCodeReview
  | CurrentTracker
  | CurrentWorkspaceManager

/** The workflow-derived inputs the first instance of each rebuildable port is built from. */
export type PortsConfiguration = Readonly<{
  tracker: Workflow['tracker']
  workspaces: WorkspaceSettings
}>

export const portsConfiguration = (workflow: Workflow): PortsConfiguration => ({
  tracker: workflow.tracker,
  workspaces: { root: workflow.config.workspaceRoot, hooks: workflow.config.hooks },
})

/**
 * The wiring shape: adapter layers supply the factories, the cells turn them into the instances in
 * force, and both halves are visible to the orchestrator. The adapter layers themselves belong to
 * the adapter issues that follow; nothing here selects a provider.
 */
export const layerPorts = (
  configuration: PortsConfiguration,
  adapters: Layer.Layer<AdapterServices>,
): Layer.Layer<PortServices, TrackerError> =>
  Layer.mergeAll(
    layerCurrentTracker(configuration.tracker),
    layerCurrentCodeReview(configuration.tracker),
    layerCurrentWorkspaceManager(configuration.workspaces),
  ).pipe(Layer.provideMerge(adapters))
