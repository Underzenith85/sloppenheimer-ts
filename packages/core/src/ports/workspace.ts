import { Context, Effect, Layer, type Scope } from 'effect'

import type { HooksConfig } from '../config/workflow.js'
import type { IssueIdentifier, Workspace } from '../domain/domain.js'
import type { WorkspaceError } from '../domain/errors.js'
import { makeAdapterCell, type AdapterCell } from './cell.js'

/**
 * The per-issue working directory lifecycle, including the operator-configured hooks that run
 * around it. `afterRun` cannot fail: the turn it follows already happened.
 */
export type WorkspaceManagerPort = Readonly<{
  create: (identifier: IssueIdentifier) => Effect.Effect<Workspace, WorkspaceError>
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

export class WorkspaceManagerFactory extends Context.Tag('symphony/WorkspaceManagerFactory')<
  WorkspaceManagerFactory,
  WorkspaceManagerFactoryPort
>() {}

export type WorkspaceManagerCell = AdapterCell<WorkspaceManagerPort, WorkspaceSettings, never>

/** The workspace manager in force now, and the seam through which a reload replaces it. */
export class CurrentWorkspaceManager extends Context.Tag('symphony/CurrentWorkspaceManager')<
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
