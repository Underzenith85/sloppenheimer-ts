import { Context, Effect, Layer, type Scope } from 'effect'

import type { HooksConfig } from '../config/workflow.js'
import type { IssueIdentifier, Workspace } from '../domain/domain.js'
import type { WorkspaceError } from '../domain/errors.js'
import type { WorkspaceRelease, WorkspaceRun } from '../domain/workspace-lease.js'
import { makeAdapterCell, type AdapterCell } from './cell.js'

/** A workspace and the run that holds its lease, which is what releasing it takes. */
export type LeasedWorkspace = Readonly<{
  run: WorkspaceRun
  workspace: Workspace
}>

/**
 * The per-run working directory lifecycle, including the operator-configured hooks that run around
 * it.
 *
 * `acquire` allocates a workspace for exactly one dispatched run or repair attempt and leases it to
 * that run: a second acquisition of the same run identity fails, before anything is launched.
 * `release` ends that ownership — a run that published its work leaves nothing behind, and every
 * other ending leaves the directory as a named recovery artifact. Neither `release` nor `afterRun`
 * can fail: the run they follow already happened.
 *
 * `exists` and `remove` are per-issue, because cleanup is: an issue that reached a terminal state
 * takes its retained workspaces with it, and never a workspace another run still holds.
 */
export type WorkspaceManagerPort = Readonly<{
  acquire: (run: WorkspaceRun) => Effect.Effect<LeasedWorkspace, WorkspaceError>
  release: (leased: LeasedWorkspace, release: WorkspaceRelease) => Effect.Effect<void>
  exists: (identifier: IssueIdentifier) => Effect.Effect<boolean, WorkspaceError>
  beforeRun: (workspace: Workspace) => Effect.Effect<void, WorkspaceError>
  afterRun: (workspace: Workspace) => Effect.Effect<void>
  remove: (identifier: IssueIdentifier) => Effect.Effect<void, WorkspaceError>
}>

/** The workflow-owned inputs a workspace manager is built from. */
export type WorkspaceSettings = Readonly<{
  root: string
  hooks: HooksConfig
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
