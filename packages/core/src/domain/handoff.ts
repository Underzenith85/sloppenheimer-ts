import type { Issue } from './domain.js'

export type PullRequestCheck = Readonly<{
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  url: string | null
}>

/**
 * One review thread, normalized. `resolved` and `outdated` are separate questions: a provider
 * marks a thread outdated when the lines it was raised on are no longer part of the change as it
 * stands, which retires the finding as a requirement without anyone having resolved it.
 */
export type PullRequestReviewThread = Readonly<{
  id: string
  resolved: boolean
  /**
   * Whether the thread no longer applies to the head that was inspected. An outdated thread is
   * review history: it stays visible, and it never becomes a repair requirement.
   */
  outdated: boolean
  body: string
  url: string | null
  /**
   * The commit the thread's first comment was written against, when the provider reports one. It
   * is provenance -- which review raised this -- and not a judgement about whether the finding
   * still applies, which is what `outdated` answers.
   */
  commentHeadSha?: string | null
}>

const unresolvedThreads = (
  observation: PullRequestObservation,
): readonly PullRequestReviewThread[] =>
  observation.reviewThreads.filter((thread) => !thread.resolved)

/**
 * The review feedback a repair has to act on: unresolved, and still applying to the head that was
 * inspected. "Unresolved" and "actionable now" are not the same question, and only this set may
 * reach a repair agent.
 */
export const currentReviewThreads = (
  observation: PullRequestObservation,
): readonly PullRequestReviewThread[] =>
  unresolvedThreads(observation).filter((thread) => !thread.outdated)

/**
 * Unresolved feedback the provider has already retired against this head. It is kept for
 * auditability -- it is why the change looks the way it does -- but it is nobody's outstanding
 * work, so it neither blocks a merge nor enters a repair request.
 *
 * It is also the only feedback that may be resolved on the provider's behalf: the provider marking
 * a thread outdated is its own statement that a later head superseded the lines it was raised on.
 * Selecting a thread here does not resolve it; the caller decides whether the head in hand has
 * earned that, and withholding a thread from a repair request never resolves it.
 */
export const outdatedReviewThreads = (
  observation: PullRequestObservation,
): readonly PullRequestReviewThread[] =>
  unresolvedThreads(observation).filter((thread) => thread.outdated)

/**
 * One line of provenance for the feedback that was withheld, for the operator rather than for the
 * agent. It records that outdated findings exist and where to read them, without restating
 * findings that a repair must not be asked to audit.
 */
export const outdatedThreadNote = (observation: PullRequestObservation): string | null => {
  const retained = outdatedReviewThreads(observation)
  if (retained.length === 0) {
    return null
  }
  const references = retained.map((thread) => thread.url ?? thread.id).join(', ')
  return `Retained review history (outdated, not part of this repair): ${String(retained.length)} thread${retained.length === 1 ? '' : 's'} -- ${references}`
}

export type CodexReviewObservation = Readonly<{
  headShaPrefix: string
  status: 'pending' | 'completed'
}>

type PullRequestObservationDetails = Readonly<{
  number: number
  checks: readonly PullRequestCheck[]
  reviewDecision: string | null
  reviewThreads: readonly PullRequestReviewThread[]
  codexReview?: CodexReviewObservation | null
  /**
   * When the provider recorded the merge, for a pull request that has one. It is kept apart from
   * the instant Sloppenheimer observed it: a handoff restored from the store after a restart is
   * observed now but may have merged days ago, and reporting the observation as the completion
   * would put long-finished work back in the console's recent-activity window.
   */
  mergedAt?: string | null
}>

export type PullRequestObservation = PullRequestObservationDetails &
  (
    | Readonly<{
        state: 'closed'
        url: string | null
        headSha: string | null
        merged: true
        mergeCommitSha: string | null
        mergeable: boolean | null
        mergeState: string | null
      }>
    | Readonly<{
        state: 'closed'
        url: string | null
        headSha: string | null
        merged: false
        mergeCommitSha: string | null
        mergeable: boolean | null
        mergeState: string | null
      }>
    | Readonly<{
        state: 'open'
        url: string
        headSha: string
        merged: false
        mergeCommitSha: string | null
        mergeable: boolean | null
        mergeState: string
      }>
  )

export type HandoffDisposition =
  | Readonly<{ state: 'merged'; mergeCommitSha: string | null }>
  | Readonly<{ state: 'closed_without_merge'; reason: string }>
  | Readonly<{ state: 'awaiting_checks'; reason: string }>
  | Readonly<{ state: 'repair_needed'; reason: string }>
  | Readonly<{ state: 'ready_to_merge'; headSha: string }>

const successfulConclusions = new Set(['success', 'neutral', 'skipped'])

export const classifyPullRequest = (observation: PullRequestObservation): HandoffDisposition => {
  if (observation.merged) {
    return { state: 'merged', mergeCommitSha: observation.mergeCommitSha }
  }
  if (observation.state === 'closed') {
    return {
      state: 'closed_without_merge',
      reason: 'The pull request was closed without being merged',
    }
  }
  if (observation.mergeable === false || observation.mergeState === 'dirty') {
    return { state: 'repair_needed', reason: 'The pull request conflicts with protected main' }
  }
  const current = currentReviewThreads(observation)
  if (current.length > 0 || observation.reviewDecision === 'CHANGES_REQUESTED') {
    const details = current.map((thread) => thread.body).filter((body) => body.length > 0)
    return {
      state: 'repair_needed',
      reason:
        details.length === 0
          ? 'The pull request has unresolved review feedback'
          : `Unresolved review feedback:\n${details.join('\n\n')}`,
    }
  }
  const incomplete = observation.checks.filter((check) => check.status !== 'completed')
  if (incomplete.length > 0) {
    return { state: 'awaiting_checks', reason: 'Required CI checks are still running' }
  }
  const failed = observation.checks.filter(
    (check) => check.conclusion === null || !successfulConclusions.has(check.conclusion),
  )
  if (failed.length > 0) {
    return {
      state: 'repair_needed',
      reason: `Failed CI checks: ${failed.map((check) => check.name).join(', ')}`,
    }
  }
  if (
    observation.mergeable === null ||
    ['blocked', 'behind', 'unknown', 'unstable'].includes(observation.mergeState)
  ) {
    return {
      state: observation.mergeState === 'behind' ? 'repair_needed' : 'awaiting_checks',
      reason:
        observation.mergeState === 'behind'
          ? 'The pull request branch is behind protected main'
          : `GitHub has not declared the pull request merge-ready (${observation.mergeState})`,
    }
  }
  return { state: 'ready_to_merge', headSha: observation.headSha }
}

export type HandoffSnapshot = Readonly<{
  issueId: string
  identifier: string
  pullRequestUrl: string
  branchName: string
  state: HandoffDisposition['state'] | 'merging' | 'intervention_required'
  headSha: string | null
  reason: string | null
  repairAttempts: number
  repairHeadShas?: readonly string[]
  /** Every head this handoff has been observed at, including repair baselines. */
  repairObservedHeadShas?: readonly string[]
  repairStartedHeadSha?: string | null
  /**
   * Whether a worker actually started from `repairStartedHeadSha`. A dispatch refused before any
   * worker launched keeps its baseline while its retry is queued, and a head that changes in the
   * meantime is nobody's output. Absent in snapshots written before this was recorded, which only
   * ever persisted a baseline once a worker had started.
   */
  repairWorkerStarted?: boolean
  reviewRequestedHeadSha?: string | null
  reviewCompletedHeadSha?: string | null
  observedAt: string
}>

/**
 * The branch an issue's completed work is expected on. It is a Sloppenheimer naming convention rather
 * than a provider one, so the core lifecycle and any code-review adapter derive it from the same
 * rule.
 */
export const issueBranchName = (issue: Issue): string => `sloppenheimer/issue-${issue.id}`
