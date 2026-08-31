import { describe, expect, it } from 'vitest'

import { classifyPullRequest } from '@symphony/core/domain/handoff.js'
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
    expect(classifyPullRequest(observation({ mergeState: 'behind' })).state).toBe('repair_needed')
  })

  it('includes unresolved review feedback in repair context', (): void => {
    expect(
      classifyPullRequest(
        observation({
          reviewThreads: [
            { id: 'thread', resolved: false, body: 'Fix the race', url: 'https://example.test' },
          ],
        }),
      ),
    ).toEqual({ state: 'repair_needed', reason: 'Unresolved review feedback:\nFix the race' })
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
        url: 'https://github.com/example/symphony/pull/41',
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
