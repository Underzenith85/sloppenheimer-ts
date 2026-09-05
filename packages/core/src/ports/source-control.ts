import { Context, Effect, Layer, Option, type Scope } from 'effect'

import type { CandidateSourceControlPort } from './candidate.js'
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

/**
 * What the host observed in a prepared worktree after an agent turn, measured against the baseline
 * recorded before the launch.
 *
 * The agent's own account of what it did is never consulted: `Clean` means the host looked and
 * found nothing to deliver, and `Changed` means there is recoverable work whether the agent
 * reported any or not.
 */
export type WorktreeInspection =
  | Readonly<{ _tag: 'Clean'; headSha: string }>
  | Readonly<{
      _tag: 'Changed'
      headSha: string
      /** Paths differing from the current commit or untracked; zero once the work is committed. */
      dirtyFileCount: number
      /**
       * Whether the worktree carries a commit the branch's remote head does not — the baseline,
       * when the preparation found no remote branch. Measured against the remote rather than the
       * baseline alone, so work that a previous publication already delivered does not read as
       * work to deliver again.
       */
      committedAhead: boolean
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
  /** Explicit candidate operations, required when host verification is configured. */
  candidates?: CandidateSourceControlPort
  prepare: (
    issue: Issue,
    workspace: Workspace,
    target: SourceControlTarget,
  ) => Effect.Effect<PreparedRepository, SourceControlError>
  /**
   * Reads the prepared worktree against its recorded baseline. Separate from {@link publish}
   * because a turn that ended is not the same event as work reaching the remote: the inspection is
   * what decides which of those the run is owed.
   */
  inspect: (prepared: PreparedRepository) => Effect.Effect<WorktreeInspection, SourceControlError>
  publish: (
    issue: Issue,
    prepared: PreparedRepository,
  ) => Effect.Effect<PublicationOutcome, SourceControlError>
  /**
   * Puts the prepared branch back on top of the protected base and publishes it under the same
   * expected-head lease a publication uses, with no agent having edited anything.
   *
   * Separate from {@link publish} because the two answer different questions of the same worktree.
   * A publication asks whether there is work to deliver and declines a clean worktree; a rebase is
   * for a worktree the host knows to be clean, where the only thing wrong is that the base has
   * moved. `NoChanges` here means the branch already sits on the base as the remote has it now, and
   * `Published` carries the rewritten head. Meant for a preparation nothing has edited: the caller
   * prepares from the exact pull-request head and hands the preparation straight here.
   */
  rebase: (
    issue: Issue,
    prepared: PreparedRepository,
  ) => Effect.Effect<PublicationOutcome, SourceControlError>
}>

export type SourceControlFactoryPort = Readonly<{
  make: (
    provider: ValidatedTrackerProvider,
  ) => Effect.Effect<SourceControlPort | null, SourceControlError, Scope.Scope>
}>

export class SourceControlFactory extends Context.Tag('sloppenheimer/SourceControlFactory')<
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

export class CurrentSourceControl extends Context.Tag('sloppenheimer/CurrentSourceControl')<
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
