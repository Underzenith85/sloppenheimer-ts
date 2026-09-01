import { Context, Effect, Layer, type Scope } from 'effect'

import type { ValidatedTrackerProvider } from '../domain/tracker-provider.js'
import type { Issue, JsonValue } from '../domain/domain.js'
import type { PullRequestObservation } from '../domain/handoff.js'
import type { TrackerError } from '../domain/errors.js'
import type { HostToolContext, HostToolResult, HostToolSpec } from '../domain/host-tools.js'
import { makeAdapterCell, type AdapterCell } from './cell.js'

/**
 * The outcome of handing completed work to review. It belongs here rather than with the tracker
 * because its pull-request variant is a code-review concept, not an issue-tracker one.
 */
export type HandoffResult =
  | Readonly<{ _tag: 'NoBranch'; branchName: string }>
  | Readonly<{
      _tag: 'PullRequest'
      branchName: string
      pullRequestUrl: string
      pullRequestNumber: number
      /** Whether this handoff opened the pull request or adopted one that already existed. */
      created: boolean
    }>

/**
 * The optional code-review capability: handing completed work over, finding a handoff that already
 * exists, and driving the proposed change to a protected merge.
 *
 * `handoffCompletedWork` takes no dispatch labels. The tracker decides what is dispatchable; a
 * code-review adapter has no use for that vocabulary.
 */
export type CodeReviewPort = Readonly<{
  /** Provider-native code-review operations advertised only when this capability is present. */
  toolSpecs: readonly HostToolSpec[]
  /** Total host-side boundary: every invocation resolves to a JSON-safe success or failure. */
  executeTool: (
    name: string,
    argumentsValue: JsonValue,
    context: HostToolContext,
  ) => Promise<HostToolResult>
  handoffCompletedWork: (issue: Issue) => Effect.Effect<HandoffResult, TrackerError>
  findExistingHandoff: (issue: Issue) => Effect.Effect<HandoffResult, TrackerError>
  inspectPullRequest: (
    pullRequestNumber: number,
  ) => Effect.Effect<PullRequestObservation, TrackerError>
  mergePullRequest: (
    pullRequestNumber: number,
    expectedHeadSha: string,
  ) => Effect.Effect<string, TrackerError>
  requestPullRequestReview: (
    pullRequestNumber: number,
    expectedHeadSha: string,
  ) => Effect.Effect<void, TrackerError>
  /**
   * Resolves review threads under a lease on the head they were judged against. The verdict that
   * retires a thread is about one head, and an inspection assembles that verdict from several
   * reads: the lease is what refuses the write when the pull request has moved past it.
   */
  resolveReviewThreads: (
    pullRequestNumber: number,
    expectedHeadSha: string,
    threadIds: readonly string[],
  ) => Effect.Effect<void, TrackerError>
}>

/**
 * Constructs the code-review capability for one validated provider, or reports its absence.
 *
 * `null` means the provider supplies no code review. That is a legitimate configuration when
 * handoff is disabled and an operator-visible configuration error when it is enabled; the gate
 * itself is not this port's to enforce.
 */
export type CodeReviewFactoryPort = Readonly<{
  make: (
    provider: ValidatedTrackerProvider,
  ) => Effect.Effect<CodeReviewPort | null, TrackerError, Scope.Scope>
}>

export class CodeReviewFactory extends Context.Tag('sloppenheimer/CodeReviewFactory')<
  CodeReviewFactory,
  CodeReviewFactoryPort
>() {}

/**
 * The absence marker: a provider that supplies no code review at all. Such a provider is not asked
 * to implement code-review wiring merely to say it has none.
 *
 * A tracker without code-review concepts is a legitimate configuration, expressed by composing no
 * code-review services at all rather than by this marker. Composing this one instead says that
 * handoff is enabled and the provider cannot serve it, which is the configuration error the
 * application reports to an operator.
 */
export const layerNoCodeReview: Layer.Layer<CodeReviewFactory> = Layer.succeed(CodeReviewFactory, {
  make: () => Effect.succeed(null),
})

export type CodeReviewCell = AdapterCell<
  CodeReviewPort | null,
  ValidatedTrackerProvider,
  TrackerError
>

/**
 * The code-review capability in force now. It is rebuilt alongside the tracker, because on GitHub
 * both are constructed from the same validated provider and both go stale on a credential rotation.
 */
export class CurrentCodeReview extends Context.Tag('sloppenheimer/CurrentCodeReview')<
  CurrentCodeReview,
  CodeReviewCell
>() {}

/** Reads the code-review capability in force now, or `null` when the provider supplies none. */
export const codeReview: Effect.Effect<CodeReviewPort | null, never, CurrentCodeReview> =
  Effect.flatMap(CurrentCodeReview, (cell) => cell.get)

export const layerCurrentCodeReview = (
  initialProvider: ValidatedTrackerProvider,
): Layer.Layer<CurrentCodeReview, TrackerError, CodeReviewFactory> =>
  Layer.scoped(
    CurrentCodeReview,
    Effect.flatMap(CodeReviewFactory, (factory) => makeAdapterCell(factory.make, initialProvider)),
  )
