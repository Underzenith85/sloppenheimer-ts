import { Option } from 'effect'

import { issueId, issueIdentifier, type Issue } from '@symphony/core/domain/domain.js'
import type { PullRequestObservation } from '@symphony/core/domain/handoff.js'
import {
  makeGitSourceControl,
  type GitSourceControlSettings,
} from '@symphony/adapter-node/source-control.js'
import type { SourceControlPort } from '@symphony/core/ports/source-control.js'
import type { GitRepositoryFixture } from './git-repository.js'

/**
 * Records a test needs to state but rarely cares about.
 *
 * A test that asserts one field of an `Issue` was still spelling out the other fourteen, so the
 * field under test read the same as the thirteen holding it up. These builders invert that: the
 * base is what every test agreed on anyway, and the override is the part the test is actually
 * about.
 *
 * The type parameter is the point. `Partial<Value>` is checked against the real record, so a field
 * renamed in `packages/core` fails the build here rather than being silently ignored as an excess
 * property — which is exactly what a hand-written literal would do once it drifted.
 */
export const fixture =
  <Value extends object>(base: Value) =>
  (overrides: Partial<Value> = {}): Value => ({ ...base, ...overrides })

/**
 * An issue in the shape the scheduler admits: open, labelled, dispatchable, nothing blocking it.
 *
 * `id` and `identifier` are derived from the identifier a caller overrides, because the two are
 * never independently interesting and letting them drift apart has no meaning.
 */
const baseIssue: Issue = {
  id: issueId('example/symphony#1'),
  nativeRef: null,
  identifier: issueIdentifier('example/symphony#1'),
  title: 'example/symphony#1',
  description: null,
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

/**
 * Builds an issue from the routable default.
 *
 * Passing `identifier` alone re-derives `id` and `title` from it, so the common case reads as one
 * argument; either can still be overridden outright.
 */
export const anIssue = (overrides: Partial<Issue> = {}): Issue => {
  const identifier = overrides.identifier ?? baseIssue.identifier
  return {
    ...baseIssue,
    id: issueId(identifier),
    identifier,
    title: identifier,
    ...overrides,
  }
}

/**
 * A pull request that is open, mergeable, and green: one passing check and no review decision.
 *
 * Typed as the open member of the observation union rather than the union itself. `Partial` of a
 * discriminated union would let a caller move `state` without the fields that correlate with it,
 * which is exactly the record this builder exists to keep valid; a test that wants a closed or
 * merged observation states one outright.
 */
export type OpenPullRequestObservation = Extract<PullRequestObservation, { state: 'open' }>

export const anOpenPullRequest = fixture<OpenPullRequestObservation>({
  number: 41,
  state: 'open',
  url: 'https://github.com/example/symphony/pull/41',
  headSha: 'abc123',
  merged: false,
  mergeCommitSha: null,
  mergeable: true,
  mergeState: 'clean',
  checks: [{ name: 'quality', status: 'completed', conclusion: 'success', url: null }],
  reviewDecision: null,
  reviewThreads: [],
})

/**
 * Git source control bound to a repository fixture, with no credential.
 *
 * The remote and base branch come from the fixture rather than being restated, so a test that
 * varies neither says neither — and the two tests that do vary the credential, and the one that
 * corrupts the remote URL, say only that.
 */
export const sourceControlFor = (
  repository: GitRepositoryFixture,
  overrides: Partial<GitSourceControlSettings> = {},
): SourceControlPort =>
  makeGitSourceControl({
    remoteUrl: repository.remote,
    baseBranch: 'main',
    credential: Option.none(),
    ...overrides,
  })
