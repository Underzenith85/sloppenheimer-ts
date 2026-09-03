import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { issueId, issueIdentifier, type Issue } from '@sloppenheimer/core/domain/domain.js'
import { rebaseInFlight, rebaseSettled, rebaseStarted } from '@sloppenheimer/core/core/rebase.js'
import type { ExecutionSnapshot, HandoffEntry } from '@sloppenheimer/core/core/state.js'
import { anIssue } from '../harness/fixtures.js'

/**
 * The host rebase's identity, as the pure functions it is: what starting one does to the handoff,
 * and what each way an attempt can end does to it. Nothing here reaches git or a tracker.
 */

const issue: Issue = anIssue({
  id: issueId('example/sloppenheimer#274'),
  identifier: issueIdentifier('example/sloppenheimer#274'),
})

/** Never called: the functions under test read no port. */
const execution = { codeReview: Option.some({}), workflow: {} } as unknown as ExecutionSnapshot

const behind: HandoffEntry = {
  issue,
  execution,
  pullRequestNumber: 7,
  pullRequestUrl: 'https://example.test/pulls/7',
  branchName: 'sloppenheimer/issue-274',
  state: 'rebase_needed',
  headSha: 'head-1',
  reason: 'The pull request branch is behind protected main',
  repairHeadShas: ['head-0'],
  repairObservedHeadShas: ['head-0', 'head-1'],
  repair: Option.none(),
  rebase: Option.none(),
  reviewRequestedHeadSha: 'head-1',
  reviewCompletedHeadSha: 'head-1',
  observedAt: new Date('2026-01-01T00:00:00.000Z'),
}

describe('a host rebase', (): void => {
  it('owns the pull request from the head it was started from until it reports back', (): void => {
    const started = rebaseStarted(behind, 'head-1')

    expect(started.rebase).toEqual(
      Option.some({ headSha: 'head-1', execution, publishedHeadSha: null }),
    )
    expect(started.state).toBe('rebase_needed')
    expect(started.reason).toBe('Rebasing the pull request branch onto protected main')
    expect(rebaseInFlight(started)).toBe(true)
    expect(rebaseInFlight(behind)).toBe(false)
  })

  it('keeps the head it pushed until the provider reports it, spending no repair', (): void => {
    const settled = rebaseSettled(rebaseStarted(behind, 'head-1'), {
      _tag: 'Published',
      headSha: 'head-2',
    })

    expect(settled.state).toBe('awaiting_checks')
    expect(settled.headSha).toBe('head-2')
    expect(settled.rebase).toEqual(
      Option.some({ headSha: 'head-1', execution, publishedHeadSha: 'head-2' }),
    )
    // Over as far as the branch is concerned: the pass may observe the pull request again.
    expect(rebaseInFlight(settled)).toBe(false)
    expect(settled.repairHeadShas).toEqual(['head-0'])
    expect(settled.repairObservedHeadShas).toEqual(['head-0', 'head-1'])
  })

  it('hands a branch that already sat on the base back to the next observation', (): void => {
    const settled = rebaseSettled(rebaseStarted(behind, 'head-1'), { _tag: 'NoChanges' })

    expect(settled.state).toBe('awaiting_checks')
    expect(settled.headSha).toBe('head-1')
    expect(Option.isNone(settled.rebase)).toBe(true)
  })

  it('asks for a human when the rebase itself conflicts', (): void => {
    const settled = rebaseSettled(rebaseStarted(behind, 'head-1'), {
      _tag: 'Conflicted',
      message: 'source-control publication could not rebase onto the protected base',
    })

    expect(settled.state).toBe('intervention_required')
    expect(settled.headSha).toBe('head-1')
    expect(settled.reason).toBe(
      'The pull request branch is behind protected main and could not be rebased onto it: source-control publication could not rebase onto the protected base',
    )
    expect(Option.isNone(settled.rebase)).toBe(true)
  })

  it('leaves any other failure for the next observation to retry', (): void => {
    const settled = rebaseSettled(rebaseStarted(behind, 'head-1'), {
      _tag: 'Failed',
      message: 'remote branch sloppenheimer/issue-274 no longer matches expected head head-1',
    })

    expect(settled.state).toBe('rebase_needed')
    expect(settled.reason).toBe(
      'Could not rebase the pull request branch onto protected main: remote branch sloppenheimer/issue-274 no longer matches expected head head-1',
    )
    expect(Option.isNone(settled.rebase)).toBe(true)
  })
})
