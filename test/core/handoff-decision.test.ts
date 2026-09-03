import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { issueId, issueIdentifier, type Issue } from '@sloppenheimer/core/domain/domain.js'
import type {
  PullRequestCheck,
  PullRequestObservation,
  PullRequestReviewThread,
} from '@sloppenheimer/core/domain/handoff.js'
import {
  afterMerge,
  attributeRepairHead,
  afterReviewRequested,
  afterThreadsResolved,
  observeHandoff,
  repairLimit,
} from '@sloppenheimer/core/core/handoff-decision.js'
import { afterRepairDispatched, repairIssue } from '@sloppenheimer/core/core/repair.js'
import type {
  ExecutionSnapshot,
  HandoffEntry,
  RepairEntry,
} from '@sloppenheimer/core/core/state.js'
import { anIssue } from '../harness/fixtures.js'

/**
 * Handoff reconciliation, exercised as what it is: a function from one observation of a pull
 * request to the handoff it produces and the single call that must follow. Nothing here reaches a
 * tracker, so the repair budget, the review gate and the cycle guard can be stated directly.
 */

const observedAt = new Date('2026-02-01T00:00:00.000Z')

const issue: Issue = anIssue({
  id: issueId('example/sloppenheimer#1'),
  identifier: issueIdentifier('example/sloppenheimer#1'),
  title: 'example/sloppenheimer#1',
  description: 'the original description',
})

/** Never called: the decision is pure, so the ports only have to be of the right shape. */
const execution = { codeReview: Option.some({}), workflow: {} } as unknown as ExecutionSnapshot

/**
 * A repair that owns `startedHeadSha`. `workerStarted` false is a dispatch refused before launch,
 * and `inFlight` false is a baseline nothing is driving any more -- restored from the store, or
 * left by a settled cancellation.
 *
 * `publication` defaults to the clean worktree, because that is the case the unchanged-head
 * verdicts below are about; the delivery cases state their own.
 */
const repairing = (
  startedHeadSha: string,
  overrides: Partial<RepairEntry> = {},
): Option.Option<RepairEntry> =>
  Option.some({
    issue,
    startedHeadSha,
    inFlight: true,
    workerStarted: true,
    publication: 'no_changes',
    publishedHeadSha: null,
    ...overrides,
  })

const handoff = (overrides: Partial<HandoffEntry> = {}): HandoffEntry => ({
  issue,
  execution,
  pullRequestNumber: 7,
  pullRequestUrl: 'https://example.test/pulls/7',
  branchName: 'sloppenheimer/issue-1',
  state: 'awaiting_checks',
  headSha: null,
  reason: null,
  repairHeadShas: [],
  repairObservedHeadShas: [],
  repair: Option.none(),
  rebase: Option.none(),
  reviewRequestedHeadSha: null,
  reviewCompletedHeadSha: null,
  observedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
})

const passingCheck: PullRequestCheck = {
  name: 'quality',
  status: 'completed',
  conclusion: 'success',
  url: null,
}

const open = (
  overrides: Partial<Extract<PullRequestObservation, Readonly<{ state: 'open' }>>> = {},
): PullRequestObservation => ({
  number: 7,
  checks: [passingCheck],
  reviewDecision: null,
  reviewThreads: [],
  state: 'open',
  url: 'https://example.test/pulls/7',
  headSha: 'head-1',
  merged: false,
  mergeCommitSha: null,
  mergeable: true,
  mergeState: 'clean',
  ...overrides,
})

const reviewed = { headShaPrefix: 'head-1', status: 'completed' } as const

describe('the review gate', (): void => {
  it('asks for a review of a head that has not been reviewed', (): void => {
    const decision = observeHandoff(handoff(), open(), observedAt)

    expect(decision.action).toEqual({ _tag: 'RequestReview', headSha: 'head-1' })
    expect(decision.handoff.state).toBe('awaiting_checks')
    expect(decision.handoff.observedAt).toBe(observedAt)
    // Not recorded until the request has actually been made.
    expect(decision.handoff.reviewRequestedHeadSha).toBeNull()
  })

  it('adopts a review that already exists for the head instead of asking again', (): void => {
    const decision = observeHandoff(handoff(), open({ codexReview: reviewed }), observedAt)

    expect(decision.action).toEqual({ _tag: 'None' })
    expect(decision.handoff.reviewRequestedHeadSha).toBe('head-1')
    expect(decision.handoff.reviewCompletedHeadSha).toBe('head-1')
  })

  it('waits while the review of the current head is still pending', (): void => {
    const decision = observeHandoff(
      handoff({ reviewRequestedHeadSha: 'head-1' }),
      open({ codexReview: { headShaPrefix: 'head-1', status: 'pending' } }),
      observedAt,
    )

    expect(decision.action).toEqual({ _tag: 'None' })
    expect(decision.handoff.reason).toBe('Waiting for Codex review of the current head to complete')
  })

  it('lets a settled review through to the disposition', (): void => {
    const decision = observeHandoff(
      handoff({ reviewRequestedHeadSha: 'head-1', reviewCompletedHeadSha: 'head-1' }),
      open({ codexReview: reviewed }),
      observedAt,
    )

    expect(decision.action).toEqual({ _tag: 'Merge', headSha: 'head-1' })
    expect(decision.handoff.state).toBe('merging')
  })

  it('forgets a completed review when a new head appears', (): void => {
    const decision = observeHandoff(
      handoff({ reviewRequestedHeadSha: 'head-0', reviewCompletedHeadSha: 'head-0' }),
      open(),
      observedAt,
    )

    expect(decision.action).toEqual({ _tag: 'RequestReview', headSha: 'head-1' })
    expect(decision.handoff.reviewCompletedHeadSha).toBeNull()
  })
})

describe('dispositions', (): void => {
  const settled = handoff({
    reviewRequestedHeadSha: 'head-1',
    reviewCompletedHeadSha: 'head-1',
  })

  it('merges a pull request that is ready', (): void => {
    const decision = observeHandoff(settled, open({ codexReview: reviewed }), observedAt)

    expect(decision.action).toEqual({ _tag: 'Merge', headSha: 'head-1' })
  })

  it('completes a pull request that was merged elsewhere', (): void => {
    const decision = observeHandoff(
      settled,
      {
        number: 7,
        checks: [],
        reviewDecision: null,
        reviewThreads: [],
        state: 'closed',
        url: null,
        headSha: 'head-1',
        merged: true,
        mergeCommitSha: 'merge-1',
        mergedAt: '2026-01-05T00:00:00.000Z',
        mergeable: null,
        mergeState: null,
      },
      observedAt,
    )

    // The provider's own instant, not the one this pass observed it at.
    expect(decision.action).toEqual({ _tag: 'Complete', mergedAt: '2026-01-05T00:00:00.000Z' })
    expect(decision.handoff.state).toBe('merged')
  })

  it('stops at a pull request that was closed without merging', (): void => {
    const decision = observeHandoff(
      settled,
      {
        number: 7,
        checks: [],
        reviewDecision: null,
        reviewThreads: [],
        state: 'closed',
        url: null,
        headSha: 'head-1',
        merged: false,
        mergeCommitSha: null,
        mergeable: null,
        mergeState: null,
      },
      observedAt,
    )

    expect(decision.action).toEqual({ _tag: 'NoteClosed' })
    expect(decision.handoff.state).toBe('closed_without_merge')
  })

  it('asks for a repair when a check failed', (): void => {
    const decision = observeHandoff(
      settled,
      open({
        codexReview: reviewed,
        checks: [{ name: 'quality', status: 'completed', conclusion: 'failure', url: null }],
      }),
      observedAt,
    )

    expect(decision.action).toMatchObject({ _tag: 'Repair', headSha: 'head-1', attempt: 1 })
    expect(decision.handoff.state).toBe('repair_needed')
  })

  it('escalates instead of repairing once the budget is spent', (): void => {
    const spent = handoff({
      reviewRequestedHeadSha: 'head-1',
      reviewCompletedHeadSha: 'head-1',
      repairHeadShas: Array.from(
        { length: repairLimit },
        (_, index) => `repaired-${String(index)}`,
      ),
    })

    const decision = observeHandoff(
      spent,
      open({
        codexReview: reviewed,
        checks: [{ name: 'quality', status: 'completed', conclusion: 'failure', url: null }],
      }),
      observedAt,
    )

    expect(decision.action).toEqual({ _tag: 'None' })
    expect(decision.handoff.state).toBe('intervention_required')
    expect(decision.handoff.reason).toMatch(/^Repair limit reached\./u)
  })
})

describe('repair attribution', (): void => {
  const dispatched = handoff({
    repair: repairing('head-0'),
    repairObservedHeadShas: ['head-0'],
    reviewRequestedHeadSha: 'head-1',
    reviewCompletedHeadSha: 'head-1',
  })

  it('counts a new head as a verified repair', (): void => {
    const decision = observeHandoff(dispatched, open({ codexReview: reviewed }), observedAt)

    expect(decision.handoff.repairHeadShas).toEqual(['head-1'])
    expect(decision.handoff.repairObservedHeadShas).toEqual(['head-0', 'head-1'])
    expect(Option.isNone(decision.handoff.repair)).toBe(true)
  })

  it('escalates when a repair returns the pull request to a head already seen', (): void => {
    const cycling = handoff({
      repair: repairing('head-0'),
      repairObservedHeadShas: ['head-0', 'head-1'],
    })

    const decision = observeHandoff(cycling, open(), observedAt)

    expect(decision.action).toEqual({ _tag: 'None' })
    expect(decision.handoff.state).toBe('intervention_required')
    expect(decision.handoff.reason).toBe(
      'Repair agent returned the pull request to an already observed repair head.',
    )
  })

  it('escalates when a repair changed nothing and the head still needs one', (): void => {
    const unchanged = handoff({
      repair: repairing('head-1'),
      repairObservedHeadShas: ['head-1'],
    })

    const decision = observeHandoff(
      unchanged,
      open({
        checks: [{ name: 'quality', status: 'completed', conclusion: 'failure', url: null }],
      }),
      observedAt,
    )

    expect(decision.handoff.state).toBe('intervention_required')
    expect(decision.handoff.reason).toMatch(
      /^Repair agent completed without changing the pull request head\./u,
    )
  })

  it('treats an unchanged head from a restored baseline as an interrupted repair', (): void => {
    const restored = handoff({
      repair: repairing('head-1', { inFlight: false }),
      repairObservedHeadShas: ['head-1'],
      reviewRequestedHeadSha: 'head-1',
      reviewCompletedHeadSha: 'head-1',
    })

    const decision = observeHandoff(
      restored,
      open({
        codexReview: reviewed,
        checks: [{ name: 'quality', status: 'completed', conclusion: 'failure', url: null }],
      }),
      observedAt,
    )

    // The budget is untouched, and the normal repair path gets to try again.
    expect(decision.handoff.repairHeadShas).toEqual([])
    expect(Option.isNone(decision.handoff.repair)).toBe(true)
    expect(decision.action).toMatchObject({ _tag: 'Repair', attempt: 1 })
  })

  it('spends one of the budget for a head a repair produced', (): void => {
    const before = handoff({
      repair: repairing('head-0'),
      repairHeadShas: [],
      repairObservedHeadShas: ['head-0'],
    })

    const attribution = attributeRepairHead(before, 'head-1')

    expect(attribution._tag).toBe('Attributed')
    expect(attribution.handoff.repairHeadShas).toEqual(['head-1'])
    expect(attribution.handoff.repairObservedHeadShas).toEqual(['head-0', 'head-1'])
    // The head is accounted for, so the repair that produced it is over.
    expect(Option.isNone(attribution.handoff.repair)).toBe(true)
  })

  it('escalates rather than spending the budget when a head has been seen before', (): void => {
    const before = handoff({
      repair: repairing('head-0'),
      repairHeadShas: [],
      repairObservedHeadShas: ['head-0', 'head-1'],
    })

    const attribution = attributeRepairHead(before, 'head-1')

    expect(attribution._tag).toBe('Cycled')
    expect(attribution.handoff.state).toBe('intervention_required')
    expect(attribution.handoff.headSha).toBe('head-1')
    expect(attribution.handoff.reason).toBe(
      'Repair agent returned the pull request to an already observed repair head.',
    )
    // No further repair can improve on a head already seen, so nothing is spent on this one.
    expect(attribution.handoff.repairHeadShas).toEqual([])
    expect(Option.isNone(attribution.handoff.repair)).toBe(true)
  })

  it('keeps the baseline for a refused dispatch, without spending the budget', (): void => {
    const before = handoff({ repairObservedHeadShas: [] })
    const dispatchIssue = { ...issue, description: 'repair me' }

    const refused = afterRepairDispatched(before, false, dispatchIssue, 'head-1', 'because')
    const started = afterRepairDispatched(before, true, dispatchIssue, 'head-1', 'because')

    // The retry has to render the same repair, so the identity outlives the refusal; the budget is
    // spent by an observed head, which is why neither of these touches repairHeadShas.
    expect(refused.repair).toEqual(
      Option.some({
        issue: dispatchIssue,
        startedHeadSha: 'head-1',
        inFlight: true,
        workerStarted: false,
        // Nothing has run, so nothing is known about the worktree yet.
        publication: 'pending',
        publishedHeadSha: null,
      }),
    )
    expect(refused.repairHeadShas).toEqual([])
    expect(refused.reason).toBe('Repair agent waiting to retry. because')

    expect(started.repair).toEqual(
      Option.some({
        issue: dispatchIssue,
        startedHeadSha: 'head-1',
        inFlight: true,
        workerStarted: true,
        publication: 'pending',
        publishedHeadSha: null,
      }),
    )
    expect(started.repairObservedHeadShas).toEqual(['head-1'])
    expect(started.reason).toBe('Repair agent running. because')
  })

  it('does not attribute a head to a restored repair whose worker never started', (): void => {
    // A dispatch refused before any worker started, whose queued retry did not outlive the
    // process. The head moved while nothing was running, so it belongs to nobody.
    const refused = handoff({
      repair: repairing('head-0', { inFlight: false, workerStarted: false }),
      repairObservedHeadShas: ['head-0'],
      reviewRequestedHeadSha: 'head-1',
      reviewCompletedHeadSha: 'head-1',
    })

    const decision = observeHandoff(
      refused,
      open({
        codexReview: reviewed,
        checks: [{ name: 'quality', status: 'completed', conclusion: 'failure', url: null }],
      }),
      observedAt,
    )

    expect(decision.handoff.repairHeadShas).toEqual([])
    expect(Option.isNone(decision.handoff.repair)).toBe(true)
    expect(decision.action).toMatchObject({ _tag: 'Repair', attempt: 1 })
  })
})

describe('a branch that is behind protected main', (): void => {
  const reviewed1 = handoff({
    reviewRequestedHeadSha: 'head-1',
    reviewCompletedHeadSha: 'head-1',
    repairHeadShas: ['head-0'],
    repairObservedHeadShas: ['head-0', 'head-1'],
  })
  const behind = open({ mergeState: 'behind', codexReview: reviewed })

  it('asks the host to rebase it, spending no repair', (): void => {
    const decision = observeHandoff(reviewed1, behind, observedAt)

    expect(decision.action).toEqual({
      _tag: 'Rebase',
      headSha: 'head-1',
      reason: 'The pull request branch is behind protected main',
    })
    expect(decision.handoff.state).toBe('rebase_needed')
    expect(decision.handoff.repairHeadShas).toEqual(['head-0'])
  })

  it('rebases even once the repair budget is spent', (): void => {
    const spent = handoff({
      reviewRequestedHeadSha: 'head-1',
      reviewCompletedHeadSha: 'head-1',
      repairHeadShas: ['head-a', 'head-b', 'head-c'],
    })

    const decision = observeHandoff(spent, behind, observedAt)

    expect(decision.action).toMatchObject({ _tag: 'Rebase', headSha: 'head-1' })
    expect(decision.handoff.state).toBe('rebase_needed')
  })

  it('does not read a repair that changed nothing on a behind branch as no progress', (): void => {
    // A repair dispatched for this before the host learned to rebase -- restored from the store,
    // or still in flight across the upgrade -- comes back with a clean worktree. That is not a
    // repair that achieved nothing: there was nothing for it to achieve.
    const decision = observeHandoff(
      handoff({
        reviewRequestedHeadSha: 'head-1',
        reviewCompletedHeadSha: 'head-1',
        repairObservedHeadShas: ['head-1'],
        repair: repairing('head-1'),
      }),
      behind,
      observedAt,
    )

    expect(decision.handoff.state).toBe('rebase_needed')
    expect(decision.action).toMatchObject({ _tag: 'Rebase', headSha: 'head-1' })
    expect(Option.isNone(decision.handoff.repair)).toBe(true)
    expect(decision.handoff.repairHeadShas).toEqual([])
  })

  it('waits for the provider to report the head a rebase pushed', (): void => {
    const published = handoff({
      state: 'awaiting_checks',
      headSha: 'head-2',
      reviewRequestedHeadSha: 'head-1',
      reviewCompletedHeadSha: 'head-1',
      rebase: Option.some({ headSha: 'head-1', publishedHeadSha: 'head-2' }),
    })

    // Still the head the rebase replaced: the provider has not caught up, and acting on it would
    // rebase the branch a second time against a lease the push already moved.
    const stale = observeHandoff(published, behind, observedAt)
    expect(stale.action).toEqual({ _tag: 'None' })
    expect(stale.handoff.state).toBe('awaiting_checks')
    expect(Option.isSome(stale.handoff.rebase)).toBe(true)

    // The pushed head, which is a new head like any other: reviewed once, then judged.
    const reported = observeHandoff(published, open({ headSha: 'head-2' }), observedAt)
    expect(reported.action).toEqual({ _tag: 'RequestReview', headSha: 'head-2' })
    expect(Option.isNone(reported.handoff.rebase)).toBe(true)
  })

  it('lets a rebase identity go once the pull request has closed', (): void => {
    const decision = observeHandoff(
      handoff({ rebase: Option.some({ headSha: 'head-1', publishedHeadSha: 'head-2' }) }),
      { ...open(), state: 'closed', merged: true, mergeCommitSha: 'merge-1' },
      observedAt,
    )

    expect(decision.action).toEqual({ _tag: 'Complete', mergedAt: null })
    expect(Option.isNone(decision.handoff.rebase)).toBe(true)
  })
})

describe('intervention', (): void => {
  it('leaves an unchanged head alone once intervention was requested', (): void => {
    const escalated = handoff({ state: 'intervention_required', headSha: 'head-1' })

    const decision = observeHandoff(escalated, open(), observedAt)

    expect(decision.action).toEqual({ _tag: 'None' })
    expect(decision.handoff.state).toBe('intervention_required')
    expect(decision.handoff.observedAt).toBe(observedAt)
  })

  it('acts normally again once the head has moved on', (): void => {
    const escalated = handoff({ state: 'intervention_required', headSha: 'head-0' })

    const decision = observeHandoff(escalated, open(), observedAt)

    expect(decision.action).toEqual({ _tag: 'RequestReview', headSha: 'head-1' })
  })
})

describe('retiring feedback a head has superseded', (): void => {
  /** Raised on an earlier head, and still raised against this one: outstanding work. */
  const standingThread: PullRequestReviewThread = {
    id: 'thread-1',
    resolved: false,
    outdated: false,
    body: 'please fix',
    url: null,
    commentHeadSha: 'head-0',
  }
  const retiredThread: PullRequestReviewThread = { ...standingThread, outdated: true }

  const clean = (overrides: Partial<HandoffEntry> = {}): HandoffEntry =>
    handoff({ reviewRequestedHeadSha: 'head-1', reviewCompletedHeadSha: 'head-1', ...overrides })

  it('resolves what the provider marked outdated once the head came back clean', (): void => {
    const decision = observeHandoff(
      clean({ repairHeadShas: ['head-1'] }),
      open({ codexReview: reviewed, reviewThreads: [retiredThread] }),
      observedAt,
    )

    expect(decision.action).toEqual({
      _tag: 'ResolveThreads',
      headSha: 'head-1',
      threadIds: ['thread-1'],
    })
    expect(decision.handoff.state).toBe('awaiting_checks')
  })

  it('resolves it on a pull request no repair was recorded for', (): void => {
    // A handoff restored from the store, or a head a human pushed the fix for, has retired threads
    // nobody else will clear. A protection rule that requires resolved conversations would hold
    // such a pull request open forever if the threads were left for a repair that never runs.
    const decision = observeHandoff(
      clean(),
      open({
        codexReview: reviewed,
        reviewThreads: [retiredThread],
        mergeState: 'blocked',
      }),
      observedAt,
    )

    expect(decision.action).toEqual({
      _tag: 'ResolveThreads',
      headSha: 'head-1',
      threadIds: ['thread-1'],
    })

    const afterwards = observeHandoff(
      decision.handoff,
      open({ codexReview: reviewed, reviewThreads: [{ ...retiredThread, resolved: true }] }),
      observedAt,
    )

    expect(afterwards.action).toEqual({ _tag: 'Merge', headSha: 'head-1' })
  })

  it('leaves a thread the provider still raises against this head outstanding', (): void => {
    const decision = observeHandoff(
      clean({ repairHeadShas: ['head-1'] }),
      open({ codexReview: reviewed, reviewThreads: [standingThread] }),
      observedAt,
    )

    // Where the comment was written is provenance, not a verdict: the finding still applies, so it
    // is repaired rather than resolved on the reviewer's behalf.
    expect(decision.action).toMatchObject({ _tag: 'Repair' })
  })

  it('waits while GitHub is still deciding, or reporting against the head', (): void => {
    for (const mergeState of ['unknown', 'unstable']) {
      const decision = observeHandoff(
        clean({ repairHeadShas: ['head-1'] }),
        // Every check run fetched is green, but GitHub has not settled: a signal it can see and
        // this observation cannot must not cost a thread its resolution.
        open({ codexReview: reviewed, reviewThreads: [retiredThread], mergeState }),
        observedAt,
      )

      expect(decision.action).toEqual({ _tag: 'None' })
      expect(decision.handoff.state).toBe('awaiting_checks')
    }
  })

  it('waits for a head that has not come back clean', (): void => {
    const decision = observeHandoff(
      clean({ repairHeadShas: ['head-1'] }),
      open({
        codexReview: reviewed,
        reviewThreads: [retiredThread],
        checks: [{ name: 'quality', status: 'completed', conclusion: 'failure', url: null }],
      }),
      observedAt,
    )

    expect(decision.action).toMatchObject({ _tag: 'Repair', reason: 'Failed CI checks: quality' })
  })
})

describe('the feedback a repair is asked to act on', (): void => {
  const reviewedHandoff = (overrides: Partial<HandoffEntry> = {}): HandoffEntry =>
    handoff({
      repairHeadShas: ['head-1'],
      repairObservedHeadShas: ['head-0', 'head-1'],
      reviewRequestedHeadSha: 'head-1',
      reviewCompletedHeadSha: 'head-1',
      ...overrides,
    })

  /** A finding raised on an earlier head that the repaired head has since retired. */
  const retired = (id: string, body: string, headSha: string): PullRequestReviewThread => ({
    id,
    resolved: false,
    outdated: true,
    body,
    url: `https://example.test/${id}`,
    commentHeadSha: headSha,
  })

  /** A finding the rereview raised against the head under inspection. */
  const raised = (id: string, body: string): PullRequestReviewThread => ({
    id,
    resolved: false,
    outdated: false,
    body,
    url: `https://example.test/${id}`,
    commentHeadSha: 'head-1',
  })

  // The six threads of PR #152, spread over three reviewed heads: four already addressed and
  // marked outdated by GitHub, two raised by the rereview of the head in hand.
  const threadsOfThreeHeads: readonly PullRequestReviewThread[] = [
    retired('thread-1', 'Addressed on head zero', 'head-0'),
    retired('thread-2', 'Also addressed on head zero', 'head-0'),
    retired('thread-3', 'Addressed on head one', 'head-a'),
    retired('thread-4', 'Also addressed on head one', 'head-a'),
    raised('thread-5', 'Guard the empty case'),
    raised('thread-6', 'Name the failure honestly'),
  ]

  const failingCheck: PullRequestCheck = {
    name: 'quality',
    status: 'completed',
    conclusion: 'failure',
    url: null,
  }

  it('supplies only the findings raised against the inspected head', (): void => {
    // The repaired head has not come back clean, so nothing is resolved this pass and the whole
    // six-thread history is still on the pull request when the repair is decided.
    const decision = observeHandoff(
      reviewedHandoff(),
      open({
        codexReview: reviewed,
        checks: [failingCheck],
        reviewThreads: threadsOfThreeHeads,
      }),
      observedAt,
    )

    const repairReason =
      'Unresolved review feedback:\nGuard the empty case\n\nName the failure honestly'
    expect(decision.action).toEqual({
      _tag: 'Repair',
      headSha: 'head-1',
      attempt: 2,
      reason: repairReason,
    })

    const prompt = repairIssue(decision.handoff, issue, 'head-1', repairReason)

    expect(prompt.description).toContain('Guard the empty case')
    expect(prompt.description).toContain('Name the failure honestly')
    for (const retiredBody of ['head zero', 'head one']) {
      expect(prompt.description).not.toContain(retiredBody)
    }
    // The operator's record keeps what the agent was not asked to audit.
    expect(decision.handoff.reason).toContain('Guard the empty case')
    expect(decision.handoff.reason).toContain(
      'Retained review history (outdated, not part of this repair): 4 threads',
    )
  })

  it('retires the superseded threads first, then repairs against what the rereview raised', (): void => {
    const clean = reviewedHandoff()
    const first = observeHandoff(
      clean,
      open({ codexReview: reviewed, reviewThreads: threadsOfThreeHeads }),
      observedAt,
    )

    // Only a published head that came back clean resolves anything, and only the threads the
    // rereview did not raise against it.
    expect(first.action).toEqual({
      _tag: 'ResolveThreads',
      headSha: 'head-1',
      threadIds: ['thread-1', 'thread-2', 'thread-3', 'thread-4'],
    })

    const second = observeHandoff(
      first.handoff,
      open({
        codexReview: reviewed,
        reviewThreads: threadsOfThreeHeads.map((thread) =>
          thread.outdated ? { ...thread, resolved: true } : thread,
        ),
      }),
      observedAt,
    )

    expect(second.action).toEqual({
      _tag: 'Repair',
      headSha: 'head-1',
      attempt: 2,
      reason: 'Unresolved review feedback:\nGuard the empty case\n\nName the failure honestly',
    })
    expect(second.handoff.reason).not.toContain('Retained review history')
  })

  it('merges a repaired head whose feedback a human resolved, and a clean rereview', (): void => {
    const humanResolved = observeHandoff(
      reviewedHandoff(),
      open({
        codexReview: reviewed,
        reviewThreads: threadsOfThreeHeads.map((thread) => ({ ...thread, resolved: true })),
      }),
      observedAt,
    )

    expect(humanResolved.action).toEqual({ _tag: 'Merge', headSha: 'head-1' })

    const cleanRereview = observeHandoff(
      reviewedHandoff(),
      open({ codexReview: reviewed, reviewThreads: [] }),
      observedAt,
    )

    expect(cleanRereview.action).toEqual({ _tag: 'Merge', headSha: 'head-1' })
  })

  it('never lets retired feedback alone spend a repair', (): void => {
    const observation = open({
      codexReview: reviewed,
      reviewThreads: [retired('thread-1', 'Addressed on head zero', 'head-0')],
      // Not clean yet, so nothing is resolved this pass and the disposition decides alone.
      checks: [failingCheck],
    })

    const decision = observeHandoff(
      handoff({ reviewRequestedHeadSha: 'head-1', reviewCompletedHeadSha: 'head-1' }),
      observation,
      observedAt,
    )

    expect(decision.action).toEqual({
      _tag: 'Repair',
      headSha: 'head-1',
      attempt: 1,
      reason: 'Failed CI checks: quality',
    })
    expect(decision.handoff.reason).toBe(
      'Failed CI checks: quality\n\nRetained review history (outdated, not part of this repair): 1 thread -- https://example.test/thread-1',
    )
  })

  it('keeps the history out of the prompt but in the intervention reason at the repair limit', (): void => {
    const decision = observeHandoff(
      reviewedHandoff({
        repairHeadShas: ['head-a', 'head-b', 'head-1'],
        repairObservedHeadShas: ['head-0', 'head-a', 'head-b', 'head-1'],
      }),
      open({
        codexReview: reviewed,
        checks: [failingCheck],
        reviewThreads: threadsOfThreeHeads,
      }),
      observedAt,
    )

    expect(decision.action).toEqual({ _tag: 'None' })
    expect(decision.handoff.state).toBe('intervention_required')
    expect(decision.handoff.reason).toContain('Repair limit reached.')
    expect(decision.handoff.reason).toContain('Guard the empty case')
    expect(decision.handoff.reason).not.toContain('Addressed on head zero')
    expect(decision.handoff.reason).toContain('Retained review history')
  })
})

describe('folding a call back into the handoff', (): void => {
  it('records a requested review, or why it could not be requested', (): void => {
    expect(afterReviewRequested(handoff(), 'head-1', null)).toMatchObject({
      reviewRequestedHeadSha: 'head-1',
      reason: 'Codex review requested for the current head',
    })
    expect(afterReviewRequested(handoff(), 'head-1', 'nope')).toMatchObject({
      reviewRequestedHeadSha: null,
      reason: 'Could not request Codex review for the current head: nope',
    })
  })

  it('returns a failed merge to awaiting checks with the reason', (): void => {
    expect(afterMerge(handoff({ state: 'merging' }), 'conflict')).toMatchObject({
      state: 'awaiting_checks',
      reason: 'conflict',
    })
    expect(afterMerge(handoff({ state: 'merging' }), null).state).toBe('merged')
  })

  it('reports what came of resolving the stale threads', (): void => {
    expect(afterThreadsResolved(handoff(), null).reason).toBe(
      'Verified repair head; waiting for resolved review state',
    )
    expect(afterThreadsResolved(handoff(), 'denied').reason).toBe('denied')
  })
})
