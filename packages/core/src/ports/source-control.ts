import { Context, Effect, Layer, Option, type Scope } from 'effect'

import type { Issue, Workspace } from '../domain/domain.js'
import type { ValidatedTrackerProvider } from '../domain/tracker-provider.js'
import type { SourceControlError } from '../domain/errors.js'
import { makeAdapterCell, type AdapterCell } from './cell.js'

export type SourceControlTarget =
  | Readonly<{ _tag: 'Normal'; branchName: string }>
  | Readonly<{ _tag: 'Repair'; branchName: string; expectedHeadSha: string }>

/** The host-owned repository state captured before an agent is launched. */
export type PreparedRepository = Readonly<{
  workspace: Workspace
  target: SourceControlTarget
  baseBranch: string
  baseSha: string
  baselineSha: string
  expectedRemoteHead: Option.Option<string>
}>

export type PublicationOutcome =
  | Readonly<{ _tag: 'NoChanges'; branchName: string; baselineSha: string }>
  | Readonly<{
      _tag: 'Published'
      branchName: string
      headSha: string
      commitCreated: boolean
    }>

/**
 * Tracker-neutral source-control capability. The host owns repository metadata, credentials and
 * publication; an agent receives only the prepared worktree and edits ordinary files inside it.
 */
export type SourceControlPort = Readonly<{
  prepare: (
    issue: Issue,
    workspace: Workspace,
    target: SourceControlTarget,
  ) => Effect.Effect<PreparedRepository, SourceControlError>
  publish: (
    issue: Issue,
    prepared: PreparedRepository,
  ) => Effect.Effect<PublicationOutcome, SourceControlError>
}>

export type SourceControlFactoryPort = Readonly<{
  make: (
    provider: ValidatedTrackerProvider,
  ) => Effect.Effect<SourceControlPort | null, SourceControlError, Scope.Scope>
}>

export class SourceControlFactory extends Context.Tag('symphony/SourceControlFactory')<
  SourceControlFactory,
  SourceControlFactoryPort
>() {}

export const layerNoSourceControl: Layer.Layer<SourceControlFactory> = Layer.succeed(
  SourceControlFactory,
  { make: () => Effect.succeed(null) },
)

export type SourceControlCell = AdapterCell<
  SourceControlPort | null,
  ValidatedTrackerProvider,
  SourceControlError
>

export class CurrentSourceControl extends Context.Tag('symphony/CurrentSourceControl')<
  CurrentSourceControl,
  SourceControlCell
>() {}

export const sourceControl: Effect.Effect<SourceControlPort | null, never, CurrentSourceControl> =
  Effect.flatMap(CurrentSourceControl, (cell) => cell.get)

export const layerCurrentSourceControl = (
  initialProvider: ValidatedTrackerProvider,
): Layer.Layer<CurrentSourceControl, SourceControlError, SourceControlFactory> =>
  Layer.scoped(
    CurrentSourceControl,
    Effect.flatMap(SourceControlFactory, (factory) =>
      makeAdapterCell(factory.make, initialProvider),
    ),
  )
