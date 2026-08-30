export type PullRequestCheck = Readonly<{
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  url: string | null
}>

export type PullRequestReviewThread = Readonly<{
  id: string
  resolved: boolean
  body: string
  url: string | null
  commentHeadSha?: string | null
}>

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
  const unresolved = observation.reviewThreads.filter((thread) => !thread.resolved)
  if (unresolved.length > 0 || observation.reviewDecision === 'CHANGES_REQUESTED') {
    const details = unresolved.map((thread) => thread.body).filter((body) => body.length > 0)
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
  reviewRequestedHeadSha?: string | null
  observedAt: string
}>
