import { Context, Effect, Layer, type Exit, type Scope } from 'effect'

import type { HooksConfig } from '../config/workflow.js'
import type { IssueIdentifier, Workspace } from '../domain/domain.js'
import type { WorkspaceError } from '../domain/errors.js'
import type { WorkspaceRelease, WorkspaceRun } from '../domain/workspace-lease.js'
import type { WorkspacePruneReport } from '../domain/workspace-retention.js'
import { makeAdapterCell, type AdapterCell } from './cell.js'

/**
 * The per-run working directory lifecycle, including the operator-configured hooks that run around
 * it.
 *
 * `withLeasedWorkspace` allocates a workspace for exactly one dispatched run or repair attempt,
 * leases it to that run for the whole of `use`, and releases it as `disposition` decides from how
 * `use` ended: a run that published its work leaves nothing behind, and every other ending leaves
 * the directory as a named recovery artifact. A second acquisition of the same run identity fails,
 * before anything is launched.
 *
 * It is a bracket rather than an acquire and a release the caller pairs up itself, because
 * ownership must not be able to escape between them: an interruption arriving in that gap would
 * leave a lease that no one holds and no one will release, and a lease this host still holds is one
 * cleanup must not touch. Releasing cannot fail, and neither can `afterRun`: the run they follow
 * already happened.
 *
 * `exists` and `remove` are per-issue, because cleanup is: an issue that reached a terminal state
 * takes its retained workspaces with it, and never a workspace another run still holds.
 *
 * `prune` bounds an issue that is not finished with: it keeps the newest retained workspaces up to
 * the manager's limit, never evicts one a live host may still want, and answers with what the
 * issue still holds — so the count and size an operator sees is measured rather than inferred.
 *
 * It takes the run that has just ended rather than only its issue, because that run's own
 * workspace must survive its own prune and only the manager can name it: a run that failed while
 * its workspace was being provisioned never received one to name, and its directory is exactly
 * the kind that holds work nothing has read. `protectedKeys` is for the workspaces of *other*
 * runs that this host still means to publish from — a retained delivery's above all.
 */
export type WorkspaceManagerPort = Readonly<{
  withLeasedWorkspace: <Value, Failure, Requirements>(
    run: WorkspaceRun,
    use: (workspace: Workspace) => Effect.Effect<Value, Failure, Requirements>,
    disposition: (exit: Exit.Exit<Value, Failure>) => WorkspaceRelease,
  ) => Effect.Effect<Value, Failure | WorkspaceError, Requirements>
  exists: (identifier: IssueIdentifier) => Effect.Effect<boolean, WorkspaceError>
  beforeRun: (workspace: Workspace) => Effect.Effect<void, WorkspaceError>
  afterRun: (workspace: Workspace) => Effect.Effect<void>
  remove: (identifier: IssueIdentifier) => Effect.Effect<void, WorkspaceError>
  prune: (
    run: WorkspaceRun,
    protectedKeys: ReadonlySet<string>,
  ) => Effect.Effect<WorkspacePruneReport, WorkspaceError>
}>

/** The workflow-owned inputs a workspace manager is built from. */
export type WorkspaceSettings = Readonly<{
  root: string
  hooks: HooksConfig
  /** How many retained run workspaces one issue keeps; `prune` enforces it. */
  retainedLimit: number
}>

/**
 * Constructs a workspace manager for one set of settings. Like the tracker, this is a factory
 * rather than a fixed instance: a workflow reload can move the workspace root or change a hook.
 */
export type WorkspaceManagerFactoryPort = Readonly<{
  make: (settings: WorkspaceSettings) => Effect.Effect<WorkspaceManagerPort, never, Scope.Scope>
}>

export class WorkspaceManagerFactory extends Context.Tag('sloppenheimer/WorkspaceManagerFactory')<
  WorkspaceManagerFactory,
  WorkspaceManagerFactoryPort
>() {}

export type WorkspaceManagerCell = AdapterCell<WorkspaceManagerPort, WorkspaceSettings, never>

/** The workspace manager in force now, and the seam through which a reload replaces it. */
export class CurrentWorkspaceManager extends Context.Tag('sloppenheimer/CurrentWorkspaceManager')<
  CurrentWorkspaceManager,
  WorkspaceManagerCell
>() {}

/** Reads the workspace manager in force now. */
export const workspaces: Effect.Effect<WorkspaceManagerPort, never, CurrentWorkspaceManager> =
  Effect.flatMap(CurrentWorkspaceManager, (cell) => cell.get)

export const layerCurrentWorkspaceManager = (
  initialSettings: WorkspaceSettings,
): Layer.Layer<CurrentWorkspaceManager, never, WorkspaceManagerFactory> =>
  Layer.scoped(
    CurrentWorkspaceManager,
    Effect.flatMap(WorkspaceManagerFactory, (factory) =>
      makeAdapterCell(factory.make, initialSettings),
    ),
  )
