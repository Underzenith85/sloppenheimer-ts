import { Context, Layer, type Effect, type Scope, type Stream } from 'effect'

import type { ValidatedTrackerProvider } from '../domain/tracker-provider.js'
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
 * Installing the watcher is a scoped acquisition, and what it yields is a stream of edits: the
 * orchestrator consumes that stream on a fiber of its own, so a change never re-enters the runtime
 * from a callback, and the watcher is torn down with the scope that acquired it rather than through
 * a `close` the orchestrator has to remember to call.
 *
 * The acquisition completes before the effect returns, so the watcher is in place by the time
 * startup continues. An edit that arrives before the consuming fiber has subscribed waits in the
 * stream instead of being missed until the next defensive poll.
 */
export type WorkflowWatcherPort = Readonly<{
  changes: (path: string) => Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
}>

export class WorkflowWatcher extends Context.Tag('symphony/WorkflowWatcher')<
  WorkflowWatcher,
  WorkflowWatcherPort
>() {}

export const layerWorkflowWatcher = (watcher: WorkflowWatcherPort): Layer.Layer<WorkflowWatcher> =>
  Layer.succeed(WorkflowWatcher, watcher)
