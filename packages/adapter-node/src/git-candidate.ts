import { Effect, Option } from 'effect'

import type { Issue } from '@sloppenheimer/core/domain/domain.js'
import { SourceControlError } from '@sloppenheimer/core/domain/errors.js'
import type {
  Candidate,
  CandidateObservation,
  CandidateSourceControlPort,
  VerifiedCandidate,
} from '@sloppenheimer/core/ports/candidate.js'
import type {
  PreparedRepository,
  PublicationOutcome,
} from '@sloppenheimer/core/ports/source-control.js'
import { gitIdentity, runGit, type GitSourceControlSettings } from './git-process.js'
import { containedIn, remoteHead, revParse, status } from './git-queries.js'
import { fetchBase, pushUnderLease, rebaseOntoBase } from './git-publication.js'
import { assertCandidate, candidateFailure } from './git-candidate-state.js'
import { verifyCandidate } from './git-verification.js'

const checkpoint = (
  settings: GitSourceControlSettings,
  issue: Issue,
  prepared: PreparedRepository,
  includeBaseline: boolean,
): Effect.Effect<Option.Option<Candidate>, SourceControlError> =>
  Effect.gen(function* () {
    const workspace = prepared.workspace
    if (!(yield* containedIn(settings, 'publish', workspace, prepared.baselineSha, 'HEAD'))) {
      return yield* Effect.fail(
        candidateFailure(
          'candidate_changed',
          'workspace no longer descends from its prepared baseline',
        ),
      )
    }
    const dirty = (yield* status(settings, 'publish', workspace)).length > 0
    if (dirty) {
      yield* runGit(settings, 'publish', workspace.path, ['add', '--all'])
      const date = (yield* runGit(settings, 'publish', workspace.path, [
        'show',
        '-s',
        '--format=%aI',
        'HEAD',
      ])).trim()
      yield* runGit(
        settings,
        'publish',
        workspace.path,
        ['commit', '-m', `sloppenheimer: ${issue.identifier} ${issue.title}`],
        { ...gitIdentity, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      )
    }
    const headSha = yield* revParse(settings, 'publish', workspace, 'HEAD')
    if (!includeBaseline && !dirty && headSha === prepared.baselineSha) {
      return Option.none()
    }
    return Option.some({
      prepared,
      headSha,
      treeSha: yield* revParse(settings, 'publish', workspace, 'HEAD^{tree}'),
      commitCreated: dirty,
    })
  })

const align = (
  settings: GitSourceControlSettings,
  candidate: Candidate,
): Effect.Effect<Candidate, SourceControlError> =>
  Effect.gen(function* () {
    yield* assertCandidate(settings, candidate)
    const base = yield* fetchBase(settings, candidate.prepared)
    if (
      yield* containedIn(settings, 'publish', candidate.prepared.workspace, base, candidate.headSha)
    ) {
      return candidate
    }
    yield* rebaseOntoBase(settings, candidate.prepared)
    return {
      ...candidate,
      headSha: yield* revParse(settings, 'publish', candidate.prepared.workspace, 'HEAD'),
      treeSha: yield* revParse(settings, 'publish', candidate.prepared.workspace, 'HEAD^{tree}'),
    }
  })

const observe = (
  settings: GitSourceControlSettings,
  candidate: Candidate,
): Effect.Effect<CandidateObservation, SourceControlError> =>
  Effect.gen(function* () {
    const prepared = candidate.prepared
    const actual = yield* remoteHead(
      settings,
      'publish',
      prepared.workspace,
      prepared.target.branchName,
    )
    if (Option.contains(actual, candidate.headSha)) {
      return { _tag: 'Published', headSha: candidate.headSha }
    }
    if (Option.isSome(actual)) {
      // Read the observed object, not a moving tracking ref. A descendant preserves the push
      // even when its acknowledgement was lost; failures to fetch remain failures, not divergence.
      yield* runGit(settings, 'publish', prepared.workspace.path, [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        actual.value,
      ])
      if (
        yield* containedIn(settings, 'publish', prepared.workspace, candidate.headSha, actual.value)
      ) {
        return { _tag: 'Published', headSha: candidate.headSha }
      }
    }
    const expected = prepared.expectedRemoteHead
    const unchanged = Option.match(expected, {
      onNone: () => Option.isNone(actual),
      onSome: (head) => Option.contains(actual, head),
    })
    return unchanged
      ? { _tag: 'Unpublished' }
      : { _tag: 'Diverged', remoteHead: Option.getOrNull(actual) }
  })

const publish = (
  settings: GitSourceControlSettings,
  verified: VerifiedCandidate,
): Effect.Effect<PublicationOutcome, SourceControlError> =>
  Effect.gen(function* () {
    const { candidate, evidence } = verified
    if (candidate.headSha !== evidence.headSha || candidate.treeSha !== evidence.treeSha) {
      return yield* Effect.fail(
        candidateFailure('candidate_changed', 'verification names a different candidate'),
      )
    }
    yield* assertCandidate(settings, candidate)
    const observed = yield* observe(settings, candidate)
    if (observed._tag === 'Diverged') {
      return yield* Effect.fail(
        new SourceControlError({
          category: 'lease_conflict',
          message: 'remote branch changed after candidate preparation',
          retryable: false,
          worktreePreserved: true,
        }),
      )
    }
    if (observed._tag === 'Unpublished') {
      // Push the checked object, never whatever HEAD might become after the final local check.
      yield* pushUnderLease(settings, candidate.prepared, candidate.headSha)
    }
    return {
      _tag: 'Published',
      branchName: candidate.prepared.target.branchName,
      headSha: candidate.headSha,
      commitCreated: candidate.commitCreated,
    }
  })

export const makeCandidateSourceControl = (
  settings: GitSourceControlSettings,
): CandidateSourceControlPort => ({
  checkpoint: (issue, prepared, includeBaseline = false) =>
    checkpoint(settings, issue, prepared, includeBaseline),
  align: (candidate) => align(settings, candidate),
  verify: (candidate, configuration, secretEnvironmentNames) =>
    verifyCandidate(settings, candidate, configuration, secretEnvironmentNames),
  observe: (candidate) => observe(settings, candidate),
  publish: (verified) => publish(settings, verified),
})
