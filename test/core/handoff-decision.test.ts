import { describe, expect, it } from 'vitest'

import { issueId, issueIdentifier, type Issue } from '../../src/domain/domain.js'
import type {
  PullRequestCheck,
  PullRequestObservation,
  PullRequestReviewThread,
} from '../../src/domain/handoff.js'
import {
  afterMerge,
  afterRepairDispatched,
  afterReviewRequested,
  afterThreadsResolved,
  observeHandoff,
  repairLimit,
} from '../../src/core/handoff-decision.js'
import type { ExecutionSnapshot, HandoffEntry } from '../../src/core/state.js'

/**
 * Handoff reconciliation, exercised as what it is: a function from one observation of a pull
 * request to the handoff it produces and the single call that must follow. Nothing here reaches a
 * tracker, so the repair budget, the review gate and the cycle guard can be stated directly.
 */

const observedAt = new Date('2026-02-01T00:00:00.000Z')

const issue: Issue = {
  id: issueId('example/symphony#1'),
  nativeRef: null,
  identifier: issueIdentifier('example/symphony#1'),
  title: 'example/symphony#1',
  description: 'the original description',
  priority: null,
  state: 'open',
  branchName: null,
  url: null,
  assigneeId: null,
  labels: ['symphony'],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
}

/** Never called: the decision is pure, so the ports only have to be of the right shape. */
const execution = { codeReview: {}, workflow: {} } as unknown as ExecutionSnapshot

const handoff = (overrides: Partial<HandoffEntry> = {}): HandoffEntry => ({
  issue,
  execution,
  pullRequestNumber: 7,
  pullRequestUrl: 'https://example.test/pulls/7',
  branchName: 'symphony/issue-1',
  state: 'awaiting_checks',
  headSha: null,
  reason: null,
  repairHeadShas: [],
  repairObservedHeadShas: [],
  repairStartedHeadSha: null,
  repairBaselineRestored: false,
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
        mergeable: null,
        mergeState: null,
      },
      observedAt,
    )

    expect(decision.action).toEqual({ _tag: 'Complete' })
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
    repairStartedHeadSha: 'head-0',
    repairObservedHeadShas: ['head-0'],
    reviewRequestedHeadSha: 'head-1',
    reviewCompletedHeadSha: 'head-1',
  })

  it('counts a new head as a verified repair', (): void => {
    const decision = observeHandoff(dispatched, open({ codexReview: reviewed }), observedAt)

    expect(decision.handoff.repairHeadShas).toEqual(['head-1'])
    expect(decision.handoff.repairObservedHeadShas).toEqual(['head-0', 'head-1'])
    expect(decision.handoff.repairStartedHeadSha).toBeNull()
  })

  it('escalates when a repair returns the pull request to a head already seen', (): void => {
    const cycling = handoff({
      repairStartedHeadSha: 'head-0',
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
      repairStartedHeadSha: 'head-1',
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
      repairStartedHeadSha: 'head-1',
      repairObservedHeadShas: ['head-1'],
      repairBaselineRestored: true,
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
    expect(decision.handoff.repairBaselineRestored).toBe(false)
    expect(decision.action).toMatchObject({ _tag: 'Repair', attempt: 1 })
  })

  it('records the baseline only once a repair session really started', (): void => {
    const before = handoff({ repairObservedHeadShas: [] })

    const refused = afterRepairDispatched(before, false, 'head-1', 'because')
    const started = afterRepairDispatched(before, true, 'head-1', 'because')

    expect(refused).toBe(before)
    expect(started.repairStartedHeadSha).toBe('head-1')
    expect(started.repairObservedHeadShas).toEqual(['head-1'])
    expect(started.reason).toBe('Repair agent running. because')
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

describe('stale review threads on a verified repair', (): void => {
  const staleThread: PullRequestReviewThread = {
    id: 'thread-1',
    resolved: false,
    body: 'please fix',
    url: null,
    commentHeadSha: 'head-0',
  }

  it('resolves threads left against an earlier head', (): void => {
    const repaired = handoff({
      repairHeadShas: ['head-1'],
      reviewRequestedHeadSha: 'head-1',
      reviewCompletedHeadSha: 'head-1',
    })

    const decision = observeHandoff(
      repaired,
      open({ codexReview: reviewed, reviewThreads: [staleThread] }),
      observedAt,
    )

    expect(decision.action).toEqual({ _tag: 'ResolveThreads', threadIds: ['thread-1'] })
    expect(decision.handoff.state).toBe('awaiting_checks')
  })

  it('leaves threads against the current head to the disposition', (): void => {
    const repaired = handoff({
      repairHeadShas: ['head-1'],
      reviewRequestedHeadSha: 'head-1',
      reviewCompletedHeadSha: 'head-1',
    })

    const decision = observeHandoff(
      repaired,
      open({
        codexReview: reviewed,
        reviewThreads: [{ ...staleThread, commentHeadSha: 'head-1' }],
      }),
      observedAt,
    )

    expect(decision.action).toMatchObject({ _tag: 'Repair' })
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
