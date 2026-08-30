import { Context, Layer, type Effect, type Scope } from 'effect'

import type { ValidatedTrackerProvider } from '../config/tracker-config.js'
import type { Workflow } from '../config/workflow.js'
import type { WorkflowError } from '../errors.js'

/**
 * Reads and validates the workflow definition at a path, and re-validates a definition already in
 * force against the host environment.
 *
 * `preflight` belongs here rather than in the orchestrator because it is the environment that makes
 * a validated provider go stale: the composition root binds the environment the credentials are
 * read from, and the orchestrator only reacts to a provider that came back different.
 */
export type WorkflowLoaderPort = Readonly<{
  load: (path: string) => Effect.Effect<Workflow, WorkflowError>
  preflight: (workflow: Workflow) => Effect.Effect<ValidatedTrackerProvider, WorkflowError>
}>

export class WorkflowLoader extends Context.Tag('symphony/WorkflowLoader')<
  WorkflowLoader,
  WorkflowLoaderPort
>() {}

export const layerWorkflowLoader = (loader: WorkflowLoaderPort): Layer.Layer<WorkflowLoader> =>
  Layer.succeed(WorkflowLoader, loader)

/**
 * Watches the workflow definition for edits.
 *
 * The watch is scoped rather than handle-returning: the caller's scope owns the watcher, so it is
 * torn down on shutdown without a `close` the orchestrator has to remember to call.
 */
export type WorkflowWatcherPort = Readonly<{
  watch: (path: string, onChange: () => void) => Effect.Effect<void, never, Scope.Scope>
}>

export class WorkflowWatcher extends Context.Tag('symphony/WorkflowWatcher')<
  WorkflowWatcher,
  WorkflowWatcherPort
>() {}

export const layerWorkflowWatcher = (watcher: WorkflowWatcherPort): Layer.Layer<WorkflowWatcher> =>
  Layer.succeed(WorkflowWatcher, watcher)
