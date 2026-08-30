import { Layer } from 'effect'

import type { Workflow } from '../config/workflow.js'
import type { TrackerError } from '../errors.js'
import { AgentRunner } from './agent-runner.js'
import {
  CodeReviewFactory,
  CurrentCodeReview,
  layerCurrentCodeReview,
  layerNoCodeReview,
} from './code-review.js'
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
  type AgentEventSemantics,
  type AgentLaunch,
  type AgentResult,
  type AgentRunnerConfig,
  type AgentRunnerPort,
  type AgentTurnOutcome,
} from './agent-runner.js'
export {
  codeReview,
  CodeReviewFactory,
  CurrentCodeReview,
  layerCurrentCodeReview,
  layerNoCodeReview,
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

/**
 * What every adapter set must supply: the two singletons and the two factories whose ports have no
 * meaningful absence. Code review is deliberately not among them — it is optional, and a provider
 * that has none supplies nothing rather than a factory that only says so.
 */
export type AdapterServices =
  | AgentRunner
  | TrackerFactory
  | WorkflowLoader
  | WorkflowWatcher
  | WorkspaceManagerFactory

/** What the orchestrator consumes: the adapter services plus the rebuildable instances. */
export type PortServices =
  | AdapterServices
  | CodeReviewFactory
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
 *
 * `codeReview` defaults to the absence marker, so a tracker provider with no review capability
 * composes without implementing any code-review wiring. It is merged beneath `adapters`, so an
 * adapter set that supplies its own code-review factory keeps it.
 */
export const layerPorts = (
  configuration: PortsConfiguration,
  adapters: Layer.Layer<AdapterServices>,
  codeReview: Layer.Layer<CodeReviewFactory> = layerNoCodeReview,
): Layer.Layer<PortServices, TrackerError> =>
  Layer.mergeAll(
    layerCurrentTracker(configuration.tracker),
    layerCurrentCodeReview(configuration.tracker),
    layerCurrentWorkspaceManager(configuration.workspaces),
  ).pipe(Layer.provideMerge(Layer.merge(codeReview, adapters)))
