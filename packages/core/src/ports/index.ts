import { Layer } from 'effect'

import type { Workflow } from '../config/workflow.js'
import type { SourceControlError, TrackerError } from '../domain/errors.js'
import { AgentRunner } from './agent-runner.js'
import {
  CodeReviewFactory,
  CurrentCodeReview,
  layerCurrentCodeReview,
  layerNoCodeReview,
} from './code-review.js'
import { CurrentTracker, layerCurrentTracker, TrackerFactory } from './tracker.js'
import {
  CurrentSourceControl,
  layerCurrentSourceControl,
  layerNoSourceControl,
  SourceControlFactory,
} from './source-control.js'
import { WorkflowLoader, WorkflowWatcher } from './workflow.js'
import {
  CurrentWorkspaceManager,
  layerCurrentWorkspaceManager,
  WorkspaceManagerFactory,
  type WorkspaceSettings,
} from './workspace.js'

export { makeAdapterCell, type AdapterCell, type AdapterRebuild } from './cell.js'
export {
  CurrentSourceControl,
  layerCurrentSourceControl,
  layerNoSourceControl,
  sourceControl,
  SourceControlFactory,
  type PreparedRepository,
  type PublicationOutcome,
  type SourceControlCell,
  type SourceControlFactoryPort,
  type SourceControlPort,
  type SourceControlTarget,
} from './source-control.js'
export {
  AgentRunner,
  layerAgentRunner,
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
  CurrentIssueControl,
  issueControlFor,
  IssueControlFactory,
  layerCurrentIssueControl,
  layerIssueControlFactory,
  type IssueControlCell,
  type IssueControlFactoryPort,
  type IssueControlPort,
} from './issue-control.js'
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
  type PreflightResult,
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
export type PortServices = AdapterServices | CurrentTracker | CurrentWorkspaceManager

/**
 * The optional code-review half. It is a separate composition because its absence is meaningful:
 * an application wired without these services has pull-request handoff disabled and follows the
 * core continuation lifecycle, while one wired with them treats a provider that supplies no
 * `CodeReviewPort` as an operator-visible configuration error.
 */
export type CodeReviewServices = CodeReviewFactory | CurrentCodeReview

/** Source control is composed beside code review and remains a distinct application capability. */
export type SourceControlServices = SourceControlFactory | CurrentSourceControl

/** The workflow-derived inputs the first instance of each rebuildable port is built from. */
export type PortsConfiguration = Readonly<{
  tracker: Workflow['tracker']
  workspaces: WorkspaceSettings
}>

export const portsConfiguration = (workflow: Workflow): PortsConfiguration => ({
  tracker: workflow.tracker,
  workspaces: {
    root: workflow.config.workspaceRoot,
    hooks: workflow.config.hooks,
    retainedLimit: workflow.config.workspaceRetainedLimit,
  },
})

/**
 * The wiring shape: adapter layers supply the factories, the cells turn them into the instances in
 * force, and both halves are visible to the orchestrator. The adapter layers themselves belong to
 * the adapter issues that follow; nothing here selects a provider.
 *
 * An adapter set may carry requirements of its own — the host filesystem, say — and they travel out
 * unchanged for the composition root to discharge, so binding one here never becomes this module's
 * business. It may fail as well: selecting a concrete adapter is the composition root's business,
 * and a selection that cannot be honoured is its error to report rather than one this module has to
 * anticipate.
 */
export const layerPorts = <Requirements = never, AdapterError = never>(
  configuration: PortsConfiguration,
  adapters: Layer.Layer<AdapterServices, AdapterError, Requirements>,
): Layer.Layer<PortServices, TrackerError | AdapterError, Requirements> =>
  Layer.mergeAll(
    layerCurrentTracker(configuration.tracker),
    layerCurrentWorkspaceManager(configuration.workspaces),
  ).pipe(Layer.provideMerge(adapters))

/**
 * The code-review half, composed only when pull-request handoff is enabled. `factory` defaults to
 * the absence marker, so a provider with no review capability still composes — and then reports the
 * configuration error the application owes an operator who enabled handoff without one.
 */
export const layerCodeReviewPorts = (
  configuration: PortsConfiguration,
  factory: Layer.Layer<CodeReviewFactory> = layerNoCodeReview,
): Layer.Layer<CodeReviewServices, TrackerError> =>
  layerCurrentCodeReview(configuration.tracker).pipe(Layer.provideMerge(factory))

export const layerSourceControlPorts = (
  configuration: PortsConfiguration,
  factory: Layer.Layer<SourceControlFactory> = layerNoSourceControl,
): Layer.Layer<SourceControlServices, SourceControlError> =>
  layerCurrentSourceControl(configuration.tracker).pipe(Layer.provideMerge(factory))
