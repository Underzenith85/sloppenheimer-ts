import { Effect } from 'effect'

import type { Issue, IssueId, JsonValue } from '../../src/domain.js'
import type { PullRequestObservation } from '../../src/handoff.js'
import type { HostToolContext, HostToolResult, HostToolSpec } from '../../src/host-tools.js'
import type { HandoffResult, IssueFetchOptions, TrackerAdapter } from '../../src/tracker.js'

export type TrackerCall =
  | Readonly<{
      operation: 'fetchIssuesByStates'
      states: readonly string[]
      dependencyLabels: readonly string[] | null
      options: IssueFetchOptions | undefined
    }>
  | Readonly<{
      operation: 'fetchIssuesByIds'
      ids: readonly IssueId[]
      options: IssueFetchOptions | undefined
    }>
  | Readonly<{ operation: 'handoffCompletedWork'; issue: Issue }>
  | Readonly<{ operation: 'findExistingHandoff'; issue: Issue }>
  | Readonly<{ operation: 'inspectPullRequest'; pullRequestNumber: number }>
  | Readonly<{ operation: 'mergePullRequest'; pullRequestNumber: number; expectedHeadSha: string }>
  | Readonly<{
      operation: 'requestPullRequestReview'
      pullRequestNumber: number
      expectedHeadSha: string
    }>
  | Readonly<{ operation: 'resolveReviewThreads'; threadIds: readonly string[] }>

/** Exact in-memory implementation of the production TrackerAdapter boundary. */
export class FakeTracker implements TrackerAdapter {
  readonly calls: TrackerCall[] = []
  readonly secretEnvironmentNames: readonly string[]
  readonly toolSpecs: readonly HostToolSpec[] = []
  issues: readonly Issue[]

  constructor(issues: readonly Issue[] = [], secretEnvironmentNames: readonly string[] = []) {
    this.issues = issues
    this.secretEnvironmentNames = secretEnvironmentNames
  }

  fetchIssuesByStates(
    states: readonly string[],
    dependencyLabels: readonly string[] | null,
    options?: IssueFetchOptions,
  ): Effect.Effect<readonly Issue[]> {
    this.calls.push({ operation: 'fetchIssuesByStates', states, dependencyLabels, options })
    const normalized = new Set(states.map((state) => state.trim().toLowerCase()))
    return Effect.succeed(
      this.issues.filter((issue) => normalized.has(issue.state.trim().toLowerCase())),
    )
  }

  fetchIssuesByIds(
    ids: readonly IssueId[],
    options?: IssueFetchOptions,
  ): Effect.Effect<readonly Issue[]> {
    this.calls.push({ operation: 'fetchIssuesByIds', ids, options })
    const selected = new Set(ids)
    return Effect.succeed(this.issues.filter((issue) => selected.has(issue.id)))
  }

  handoffCompletedWork(issue: Issue): Effect.Effect<HandoffResult> {
    this.calls.push({ operation: 'handoffCompletedWork', issue })
    return Effect.succeed({ _tag: 'NoBranch', branchName: issue.branchName ?? issue.identifier })
  }

  findExistingHandoff(issue: Issue): Effect.Effect<HandoffResult> {
    this.calls.push({ operation: 'findExistingHandoff', issue })
    return Effect.succeed({ _tag: 'NoBranch', branchName: issue.branchName ?? issue.identifier })
  }

  inspectPullRequest(pullRequestNumber: number): Effect.Effect<PullRequestObservation> {
    this.calls.push({ operation: 'inspectPullRequest', pullRequestNumber })
    return Effect.succeed({
      number: pullRequestNumber,
      state: 'open',
      url: `https://example.test/pulls/${String(pullRequestNumber)}`,
      headSha: 'fake-head',
      merged: false,
      mergeCommitSha: null,
      mergeable: true,
      mergeState: 'clean',
      checks: [],
      reviewDecision: null,
      reviewThreads: [],
    })
  }

  mergePullRequest(pullRequestNumber: number, expectedHeadSha: string): Effect.Effect<string> {
    this.calls.push({ operation: 'mergePullRequest', pullRequestNumber, expectedHeadSha })
    return Effect.succeed(expectedHeadSha)
  }

  requestPullRequestReview(
    pullRequestNumber: number,
    expectedHeadSha: string,
  ): Effect.Effect<void> {
    this.calls.push({ operation: 'requestPullRequestReview', pullRequestNumber, expectedHeadSha })
    return Effect.void
  }

  resolveReviewThreads(threadIds: readonly string[]): Effect.Effect<void> {
    this.calls.push({ operation: 'resolveReviewThreads', threadIds })
    return Effect.void
  }

  executeTool(
    name: string,
    _argumentsValue: JsonValue,
    _context: HostToolContext,
  ): Promise<HostToolResult> {
    return Promise.resolve({
      success: false,
      error: {
        code: 'unsupported_tool',
        message: `Unsupported host tool: ${name}`,
        retryable: false,
      },
    })
  }
}

const trackerBoundary: TrackerAdapter = new FakeTracker()
void trackerBoundary
