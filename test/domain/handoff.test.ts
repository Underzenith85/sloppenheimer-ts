import { describe, expect, it } from 'vitest'

import {
  classifyPullRequest,
  currentReviewThreads,
  outdatedReviewThreads,
  outdatedThreadNote,
  type PullRequestReviewThread,
} from '@sloppenheimer/core/domain/handoff.js'
import { anOpenPullRequest as observation } from '../harness/fixtures.js'

describe('pull request handoff state machine', (): void => {
  it('waits for checks and rejects stale or failed heads', (): void => {
    expect(classifyPullRequest(observation({ checks: [], mergeState: 'clean' }))).toEqual({
      state: 'ready_to_merge',
      headSha: 'abc123',
    })
    expect(
      classifyPullRequest(
        observation({
          checks: [{ name: 'quality', status: 'completed', conclusion: 'failure', url: null }],
        }),
      ),
    ).toEqual({ state: 'repair_needed', reason: 'Failed CI checks: quality' })
  })

  it('asks the host, not an agent, to bring a branch that is merely behind up to date', (): void => {
    // Nothing about the change is wrong; only the base has moved. A repair agent dispatched for
    // this had nothing to change, and its clean worktree read as a repair that achieved nothing.
    expect(classifyPullRequest(observation({ mergeState: 'behind' }))).toEqual({
      state: 'rebase_needed',
      reason: 'The pull request branch is behind protected main',
    })
    // Whatever else is wrong with the head comes first: a failing check on a behind branch is
    // still the agent's to fix, and its publication rebases anyway.
    expect(
      classifyPullRequest(
        observation({
          mergeState: 'behind',
          checks: [{ name: 'quality', status: 'completed', conclusion: 'failure', url: null }],
        }),
      ),
    ).toEqual({ state: 'repair_needed', reason: 'Failed CI checks: quality' })
  })

  it('includes unresolved review feedback in repair context', (): void => {
    expect(
      classifyPullRequest(
        observation({
          reviewThreads: [
            {
              id: 'thread',
              resolved: false,
              outdated: false,
              body: 'Fix the race',
              url: 'https://example.test',
            },
          ],
        }),
      ),
    ).toEqual({ state: 'repair_needed', reason: 'Unresolved review feedback:\nFix the race' })
  })

  it('withholds outdated feedback from the repair request and keeps it as history', (): void => {
    const outdated = (id: string, body: string): PullRequestReviewThread => ({
      id,
      resolved: false,
      outdated: true,
      body,
      url: `https://example.test/${id}`,
    })
    const current = (id: string, body: string): PullRequestReviewThread => ({
      id,
      resolved: false,
      outdated: false,
      body,
      url: `https://example.test/${id}`,
    })

    // PR #152: six unresolved threads across three reviewed heads, four of them already retired
    // by the head under inspection.
    const observed = observation({
      reviewThreads: [
        outdated('thread-1', 'Addressed on head one'),
        outdated('thread-2', 'Addressed on head one as well'),
        outdated('thread-3', 'Addressed on head two'),
        outdated('thread-4', 'Also addressed on head two'),
        current('thread-5', 'Guard the empty case'),
        current('thread-6', 'Name the failure honestly'),
      ],
    })

    expect(classifyPullRequest(observed)).toEqual({
      state: 'repair_needed',
      reason: 'Unresolved review feedback:\nGuard the empty case\n\nName the failure honestly',
    })
    expect(outdatedReviewThreads(observed).map((thread) => thread.id)).toEqual([
      'thread-1',
      'thread-2',
      'thread-3',
      'thread-4',
    ])
    expect(currentReviewThreads(observed).map((thread) => thread.id)).toEqual([
      'thread-5',
      'thread-6',
    ])
    expect(outdatedThreadNote(observed)).toBe(
      'Retained review history (outdated, not part of this repair): 4 threads -- https://example.test/thread-1, https://example.test/thread-2, https://example.test/thread-3, https://example.test/thread-4',
    )
  })

  it('never lets outdated feedback alone hold a green pull request', (): void => {
    const retired: PullRequestReviewThread = {
      id: 'thread-1',
      resolved: false,
      outdated: true,
      body: 'Fix the race',
      url: null,
    }

    expect(classifyPullRequest(observation({ reviewThreads: [retired] }))).toEqual({
      state: 'ready_to_merge',
      headSha: 'abc123',
    })
    // A current thread blocks on its own account, not because its text is new: the same finding
    // raised again against this head is outstanding work.
    expect(
      classifyPullRequest(
        observation({ reviewThreads: [retired, { ...retired, id: 'thread-2', outdated: false }] }),
      ),
    ).toEqual({ state: 'repair_needed', reason: 'Unresolved review feedback:\nFix the race' })
    // A reviewer's standing request for changes still blocks, with nothing outdated quoted at the
    // agent as though it were current.
    expect(
      classifyPullRequest(
        observation({ reviewThreads: [retired], reviewDecision: 'CHANGES_REQUESTED' }),
      ),
    ).toEqual({
      state: 'repair_needed',
      reason: 'The pull request has unresolved review feedback',
    })
  })

  it('ignores a thread a human resolved, outdated or not', (): void => {
    expect(
      classifyPullRequest(
        observation({
          reviewThreads: [
            { id: 'thread-1', resolved: true, outdated: false, body: 'Fix the race', url: null },
            { id: 'thread-2', resolved: true, outdated: true, body: 'Old finding', url: null },
          ],
        }),
      ),
    ).toEqual({ state: 'ready_to_merge', headSha: 'abc123' })
  })

  it('permits only a clean current head to merge', (): void => {
    expect(classifyPullRequest(observation())).toEqual({
      state: 'ready_to_merge',
      headSha: 'abc123',
    })
    expect(
      classifyPullRequest({
        ...observation(),
        state: 'closed',
        merged: true,
        mergeCommitSha: 'merged123',
      }),
    ).toEqual({ state: 'merged', mergeCommitSha: 'merged123' })
  })

  it('classifies a closed pull request separately from a dirty open pull request', (): void => {
    expect(
      classifyPullRequest({
        number: 41,
        state: 'closed',
        url: 'https://github.com/example/sloppenheimer/pull/41',
        headSha: 'abc123',
        merged: false,
        mergeCommitSha: null,
        mergeable: false,
        mergeState: 'dirty',
        checks: [],
        reviewDecision: null,
        reviewThreads: [],
      }),
    ).toEqual({
      state: 'closed_without_merge',
      reason: 'The pull request was closed without being merged',
    })
    expect(classifyPullRequest(observation({ mergeable: false, mergeState: 'dirty' }))).toEqual({
      state: 'repair_needed',
      reason: 'The pull request conflicts with protected main',
    })
  })
})
