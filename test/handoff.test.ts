import { describe, expect, it } from 'vitest'

import { classifyPullRequest, type PullRequestObservation } from '../src/handoff.js'

const observation = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation => ({
  number: 41,
  url: 'https://github.com/example/symphony/pull/41',
  headSha: 'abc123',
  merged: false,
  mergeCommitSha: null,
  mergeable: true,
  mergeState: 'clean',
  checks: [{ name: 'quality', status: 'completed', conclusion: 'success', url: null }],
  reviewDecision: null,
  reviewThreads: [],
  ...overrides,
})

describe('pull request handoff state machine', (): void => {
  it('waits for checks and rejects stale or failed heads', (): void => {
    expect(classifyPullRequest(observation({ checks: [] })).state).toBe('awaiting_checks')
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
    expect(classifyPullRequest(observation({ merged: true, mergeCommitSha: 'merged123' }))).toEqual(
      { state: 'merged', mergeCommitSha: 'merged123' },
    )
  })
})
