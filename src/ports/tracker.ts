import { Context, Effect, Layer, type Scope } from 'effect'

import type { ValidatedTrackerProvider } from '../domain/tracker-provider.js'
import type { Issue, IssueId, JsonValue } from '../domain/domain.js'
import type { TrackerError } from '../errors.js'
import type { HostToolContext, HostToolResult, HostToolSpec } from '../host-tools.js'
import { makeAdapterCell, type AdapterCell } from './cell.js'

export type IssueFetchOptions = Readonly<{ hydrateDependencies: boolean }>

/**
 * Everything the orchestrator needs from an issue tracker, in tracker-neutral terms.
 *
 * Pull-request handoff is deliberately absent: it is an optional application capability owned by
 * `CodeReviewPort`, so a tracker that has no code-review concept is not asked to simulate one. See
 * the port boundary recorded in `AGENTS.md`.
 */
export type TrackerPort = Readonly<{
  /**
   * Reads every normalized record in provider scope for the given states, including
   * `dispatchable=false`; dispatch filtering belongs to the orchestrator.
   *
   * `dependencyLabels` selects blocker hydration: `null` hydrates every dispatch candidate, a list
   * hydrates only candidates carrying all of those labels, and an empty list hydrates none.
   */
  fetchIssuesByStates: (
    states: readonly string[],
    dependencyLabels: readonly string[] | null,
    options?: IssueFetchOptions,
  ) => Effect.Effect<readonly Issue[], TrackerError>
  fetchIssuesByIds: (
    ids: readonly IssueId[],
    options?: IssueFetchOptions,
  ) => Effect.Effect<readonly Issue[], TrackerError>
  /**
   * Issue-state operations the adapter advertises to a session, expressed as provider-native tools
   * rather than as a fixed mutation vocabulary the orchestrator would have to translate.
   */
  toolSpecs: readonly HostToolSpec[]
  /** Total host-side boundary: every invocation resolves to a JSON-safe success or failure. */
  executeTool: (
    name: string,
    argumentsValue: JsonValue,
    context: HostToolContext,
  ) => Promise<HostToolResult>
  /** Tracker credentials the host removes from agent subprocess environments. */
  secretEnvironmentNames: readonly string[]
}>

/**
 * Constructs a tracker for one validated provider.
 *
 * The provider is a parameter rather than layer configuration because it is not fixed for the run:
 * a workflow reload or a credential rotation produces a new validated provider and therefore a new
 * tracker.
 */
export type TrackerFactoryPort = Readonly<{
  make: (
    provider: ValidatedTrackerProvider,
  ) => Effect.Effect<TrackerPort, TrackerError, Scope.Scope>
}>

export class TrackerFactory extends Context.Tag('symphony/TrackerFactory')<
  TrackerFactory,
  TrackerFactoryPort
>() {}

export type TrackerCell = AdapterCell<TrackerPort, ValidatedTrackerProvider, TrackerError>

/** The tracker in force now, and the seam through which a reload installs its replacement. */
export class CurrentTracker extends Context.Tag('symphony/CurrentTracker')<
  CurrentTracker,
  TrackerCell
>() {}

/** Reads the tracker in force now. */
export const tracker: Effect.Effect<TrackerPort, never, CurrentTracker> = Effect.flatMap(
  CurrentTracker,
  (cell) => cell.get,
)

export const layerCurrentTracker = (
  initialProvider: ValidatedTrackerProvider,
): Layer.Layer<CurrentTracker, TrackerError, TrackerFactory> =>
  Layer.scoped(
    CurrentTracker,
    Effect.flatMap(TrackerFactory, (factory) => makeAdapterCell(factory.make, initialProvider)),
  )
