import { describe, expect, it } from 'vitest'

import { classifyPullRequest, type PullRequestObservation } from '../../src/handoff.js'

const observation: PullRequestObservation = {
  number: 19,
  url: 'https://github.com/Underzenith85/symphony-ts/pull/19',
  headSha: 'isolated-head',
  merged: false,
  mergeCommitSha: null,
  mergeable: true,
  mergeState: 'clean',
  checks: [{ name: 'check', status: 'completed', conclusion: 'success', url: null }],
  reviewDecision: 'APPROVED',
  reviewThreads: [],
}

describe('Extension Conformance: GitHub pull-request handoff', (): void => {
  it('requires checks, reviews, mergeability, and the observed head before merge', (): void => {
    expect(classifyPullRequest(observation)).toEqual({
      state: 'ready_to_merge',
      headSha: 'isolated-head',
    })
    expect(
      classifyPullRequest({
        ...observation,
        reviewThreads: [{ id: 'thread', resolved: false, body: 'change this', url: null }],
      }),
    ).toMatchObject({ state: 'repair_needed' })
  })
})
