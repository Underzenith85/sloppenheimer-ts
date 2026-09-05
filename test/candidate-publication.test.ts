import { makeDurableHost } from '@sloppenheimer/core/core/durable/live-journal.js'
import { openWorkflowStore } from '@sloppenheimer/adapter-node/workflow-store.js'
import { writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { makeCandidateSourceControl } from '@sloppenheimer/adapter-node/git-candidate.js'
import { makeGitSourceControl } from '@sloppenheimer/adapter-node/source-control.js'
import { retainFailedCandidate } from '@sloppenheimer/core/core/failed-candidate.js'
import { AgentError, SourceControlError } from '@sloppenheimer/core/domain/errors.js'
import { runVerifiedPublication } from '@sloppenheimer/core/core/verified-publication.js'
import { anIssue } from './harness/fixtures.js'
import { makeGitRepository, git, commitFile } from './harness/git-repository.js'

const roots: string[] = []
afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = Effect.gen(function* () {
  const repository = yield* Effect.promise(makeGitRepository)
  roots.push(repository.root)
  const settings = { remoteUrl: repository.remote, baseBranch: 'main', credential: Option.none() }
  const source = makeGitSourceControl(settings)
  const candidates = makeCandidateSourceControl(settings)
  const issue = anIssue()
  const prepared = yield* source.prepare(
    issue,
    { path: repository.workspace, key: 'candidate' },
    { _tag: 'Normal', branchName: 'candidate/test' },
  )
  yield* Effect.promise(() =>
    writeFile(join(repository.workspace, 'change.ts'), 'export const changed = true\n'),
  )
  return { repository, source, candidates, issue, prepared }
})

const gate = { command: 'test -f change.ts', timeoutMs: 5_000 }

describe('exact candidate publication', () => {
  it.live('aligns before verification and publishes exactly the verified object', () =>
    Effect.gen(function* () {
      const { repository, source, issue, prepared } = yield* fixture
      yield* Effect.promise(() =>
        commitFile(repository.seed, 'new-base.txt', 'new base', 'advance base'),
      )
      yield* Effect.promise(() => git(repository.seed, ['push', 'origin', 'main']))
      const outcome = yield* runVerifiedPublication(
        source,
        issue,
        prepared,
        { ...gate, command: 'test -f new-base.txt && test -f change.ts' },
        [],
      )
      expect(outcome._tag).toBe('Published')
      if (outcome._tag !== 'Published') {
        return
      }
      expect(
        yield* Effect.promise(() =>
          git(repository.remote, ['rev-parse', 'refs/heads/candidate/test']),
        ),
      ).toBe(outcome.headSha)
    }),
  )

  it.live('retains a failed gate without creating a remote branch', () =>
    Effect.gen(function* () {
      const { repository, source, issue, prepared } = yield* fixture
      const error = yield* Effect.flip(
        runVerifiedPublication(source, issue, prepared, { ...gate, command: 'exit 7' }, []),
      )
      expect(error).toMatchObject({
        category: 'verification_failed',
        retryable: false,
        worktreePreserved: true,
      })
      expect(
        yield* Effect.promise(() => readFile(join(repository.workspace, 'change.ts'), 'utf8')),
      ).toContain('changed')
      expect(
        yield* Effect.promise(() =>
          git(repository.remote, ['for-each-ref', 'refs/heads/candidate/test']),
        ),
      ).toBe('')
    }),
  )

  it.live('rejects a passing gate that changes the candidate', () =>
    Effect.gen(function* () {
      const { source, issue, prepared } = yield* fixture
      const error = yield* Effect.flip(
        runVerifiedPublication(
          source,
          issue,
          prepared,
          { ...gate, command: 'echo changed >> change.ts' },
          [],
        ),
      )
      expect(error.category).toBe('candidate_changed')
    }),
  )

  it.live('invalidates evidence after mutation and reconciles an already accepted push', () =>
    Effect.gen(function* () {
      const { repository, candidates, issue, prepared } = yield* fixture
      const checkpoint = yield* candidates.checkpoint(issue, prepared)
      expect(Option.isSome(checkpoint)).toBe(true)
      if (Option.isNone(checkpoint)) {
        return
      }
      const aligned = yield* candidates.align(checkpoint.value)
      const verified = yield* candidates.verify(aligned, gate, [])
      yield* Effect.promise(() => writeFile(join(repository.workspace, 'change.ts'), 'mutation'))
      expect((yield* Effect.flip(candidates.publish(verified))).category).toBe('candidate_changed')
      yield* Effect.promise(() => git(repository.workspace, ['checkout', '--', 'change.ts']))
      const first = yield* candidates.publish(verified)
      const observation = yield* candidates.observe(aligned)
      expect(observation).toEqual({ _tag: 'Published', headSha: aligned.headSha })
      // Simulate loss of the first acknowledgement: the same request observes, without rewriting.
      expect(yield* candidates.publish(verified)).toEqual(first)
      expect(
        yield* Effect.promise(() =>
          git(repository.remote, ['rev-parse', 'refs/heads/candidate/test']),
        ),
      ).toBe(aligned.headSha)
    }),
  )

  it.live('checkpoints partial edits without publishing after the agent fails', () =>
    Effect.gen(function* () {
      const { repository, source, issue, prepared } = yield* fixture
      const result = yield* retainFailedCandidate(
        source,
        issue,
        prepared,
        new AgentError({ category: 'turn_timeout', message: 'session timed out' }),
      )
      expect(result.outcome).toBe('failed')
      expect(result.postflight).toMatchObject({
        _tag: 'DeliveryFailed',
        failure: { category: 'candidate_partial', retryable: false, worktreePreserved: true },
      })
      expect(
        yield* Effect.promise(() => git(repository.workspace, ['status', '--porcelain'])),
      ).toBe('')
      expect(
        yield* Effect.promise(() => git(repository.workspace, ['rev-parse', 'HEAD'])),
      ).not.toBe(prepared.baselineSha)
      expect(
        yield* Effect.promise(() =>
          git(repository.remote, ['for-each-ref', 'refs/heads/candidate/test']),
        ),
      ).toBe('')
    }),
  )

  it.live('holds a checked candidate when the final eligibility check refuses publication', () =>
    Effect.gen(function* () {
      const { repository, source, issue, prepared } = yield* fixture
      const error = yield* Effect.flip(
        runVerifiedPublication(source, issue, prepared, gate, [], {
          beforePublish: Effect.fail(
            new SourceControlError({
              category: 'publication_blocked',
              message: 'issue gone',
              retryable: false,
              worktreePreserved: true,
            }),
          ),
        }),
      )
      expect(error.category).toBe('publication_blocked')
      expect(
        yield* Effect.promise(() =>
          git(repository.remote, ['for-each-ref', 'refs/heads/candidate/test']),
        ),
      ).toBe('')
    }),
  )

  it.live('refuses to reuse old evidence after the protected base changes', () =>
    Effect.gen(function* () {
      const { repository, candidates, issue, prepared } = yield* fixture
      const checkpoint = yield* candidates.checkpoint(issue, prepared)
      if (Option.isNone(checkpoint)) {
        return
      }
      const verified = yield* candidates.verify(checkpoint.value, gate, [])
      yield* Effect.promise(() =>
        commitFile(repository.seed, 'base-change.txt', 'changed base', 'base change'),
      )
      yield* Effect.promise(() => git(repository.seed, ['push', 'origin', 'main']))
      const aligned = yield* candidates.align(checkpoint.value)
      expect(aligned.treeSha).not.toBe(verified.evidence.treeSha)
      expect(
        (yield* Effect.flip(
          candidates.publish({ candidate: aligned, evidence: verified.evidence }),
        )).category,
      ).toBe('candidate_changed')
    }),
  )
})

it.live('retains the exact pushed candidate across restart when push acknowledgement is lost', () =>
  Effect.gen(function* () {
    const { repository, source, candidates, issue, prepared } = yield* fixture
    const path = join(repository.root, 'workflow.sqlite')
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openWorkflowStore(path, true)
        const host = yield* makeDurableHost(store)
        const journal = yield* host
          .start(issue, prepared.target)
          .pipe(Effect.map(Option.getOrThrow))
        yield* journal.prepared(prepared)
        const lostAcknowledgement = {
          ...source,
          candidates: {
            ...candidates,
            publish: (
              verified: Parameters<typeof candidates.publish>[0],
            ): ReturnType<typeof candidates.publish> =>
              Effect.gen(function* () {
                const durable = (yield* store.list.pipe(Effect.orDie))[0]
                expect(durable?.artifact?.repository?.headSha).toBe(verified.candidate.headSha)
                expect(durable?.artifact?.verifiedRevision).toBe(verified.candidate.treeSha)
                yield* candidates.publish(verified)
                return yield* Effect.fail(
                  new SourceControlError({
                    category: 'publication_failed',
                    message: 'acknowledgement lost',
                    retryable: true,
                    worktreePreserved: true,
                  }),
                )
              }),
          },
        }
        yield* Effect.flip(
          runVerifiedPublication(lostAcknowledgement, issue, prepared, gate, [], {
            journal: journal.publication,
          }),
        )
      }),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openWorkflowStore(path, true)
        const host = yield* makeDurableHost(store)
        const record = (yield* host.snapshot)[0]
        const remoteHead = yield* Effect.promise(() =>
          git(repository.remote, ['rev-parse', 'refs/heads/candidate/test']),
        )
        expect(record?.artifact?.repository?.headSha).toBe(remoteHead)
        expect(record?.artifact?.verifiedRevision).toBe(record?.artifact?.repository?.treeSha)
        expect(record?.artifact?.publishedHead).toBe(null)
        // Recovery must succeed even when the old workspace cannot be opened.
        yield* Effect.promise(() => rm(repository.workspace, { recursive: true, force: true }))
        if (source.recovery === undefined) {
          return yield* Effect.die('Git must provide remote-only recovery')
        }
        yield* host.reconcilePublication(issue.id, source.recovery)
        const reconciled = (yield* host.snapshot)[0]
        expect(reconciled?.artifact?.publishedHead).toBe(remoteHead)
        expect(reconciled?.artifact?.remoteObservation?.headSha).toBe(remoteHead)
        expect(reconciled?.status._tag).toBe('Intervention')

        expect(record?.status._tag).toBe('Intervention')
        expect(Option.isNone(yield* host.start(issue, prepared.target))).toBe(true)
      }),
    )
  }),
)

it.live('durably settles an already-current host rebase without pushing or stranding repair', () =>
  Effect.gen(function* () {
    const { repository, source, issue, prepared } = yield* fixture
    const path = join(repository.root, 'noop.sqlite')
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openWorkflowStore(path, true)
        const host = yield* makeDurableHost(store)
        const first = yield* host.start(issue, prepared.target).pipe(Effect.map(Option.getOrThrow))
        yield* first.prepared(prepared)
        const published = yield* runVerifiedPublication(source, issue, prepared, gate, [], {
          journal: first.publication,
        })
        if (published._tag !== 'Published') {
          return yield* Effect.die('fixture must publish')
        }
        const target = {
          _tag: 'Repair',
          branchName: prepared.target.branchName,
          expectedHeadSha: published.headSha,
        } as const
        const journal = yield* host.start(issue, target).pipe(Effect.map(Option.getOrThrow))
        const repair = yield* source.prepare(issue, prepared.workspace, target)
        yield* journal.prepared(repair)
        if (source.candidates === undefined) {
          return yield* Effect.die('fixture must have candidate capability')
        }
        const observing: typeof source = {
          ...source,
          candidates: {
            ...source.candidates,
            publish: () => Effect.die('an unchanged rebase must not push'),
          },
        }
        const result = yield* runVerifiedPublication(observing, issue, repair, gate, [], {
          journal: journal.publication,
          rebaseOnly: true,
        })
        expect(result._tag).toBe('NoChanges')
        const settled = (yield* host.snapshot)[0]
        expect(settled?.status).toMatchObject({ _tag: 'Waiting', condition: 'review' })
        expect(settled?.artifact?.verifiedRevision).toBe(settled?.artifact?.repository?.treeSha)
        expect(settled?.artifact?.publishedHead).toBe(published.headSha)
        const restored = yield* makeDurableHost(store)
        expect(Option.isSome(yield* restored.start(issue, target))).toBe(true)
      }),
    )
  }),
)

for (const descendant of [false, true]) {
  it.live(
    'settles an observed push without new eligibility or mutation, descendant=' +
      String(descendant),
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { repository, source, candidates, issue, prepared } = yield* fixture
          const store = yield* openWorkflowStore(join(repository.root, 'observed.sqlite'), true)
          const host = yield* makeDurableHost(store)
          const journal = yield* host
            .start(issue, prepared.target)
            .pipe(Effect.map(Option.getOrThrow))
          yield* journal.prepared(prepared)
          const checkpoint = yield* candidates
            .checkpoint(issue, prepared)
            .pipe(Effect.map(Option.getOrThrow))
          const verified = yield* candidates.verify(checkpoint, gate, [])
          yield* journal.publication.verified(verified)
          yield* candidates.publish(verified)
          if (descendant) {
            yield* Effect.promise(() => git(repository.seed, ['fetch', 'origin', 'candidate/test']))
            yield* Effect.promise(() =>
              git(repository.seed, ['checkout', '-B', 'candidate/test', 'FETCH_HEAD']),
            )
            yield* Effect.promise(() =>
              commitFile(repository.seed, 'review.txt', 'review', 'advance candidate'),
            )
            yield* Effect.promise(() => git(repository.seed, ['push', 'origin', 'candidate/test']))
          }
          const remote = yield* Effect.promise(() =>
            git(repository.remote, ['rev-parse', 'refs/heads/candidate/test']),
          )
          const observed: typeof source = {
            ...source,
            candidates: {
              ...candidates,
              publish: () => Effect.die('must not publish a known fact'),
            },
          }
          const result = yield* runVerifiedPublication(observed, issue, prepared, gate, [], {
            journal: journal.publication,
            beforePublish: Effect.fail(
              new SourceControlError({
                category: 'publication_blocked',
                message: 'tracker unavailable or issue ineligible',
                retryable: false,
                worktreePreserved: true,
              }),
            ),
          })
          expect(result).toMatchObject({ _tag: 'Published', headSha: checkpoint.headSha })
          expect((yield* host.snapshot)[0]?.artifact?.publishedHead).toBe(checkpoint.headSha)
          expect((yield* host.snapshot)[0]?.status).toMatchObject({
            _tag: 'Waiting',
            condition: 'review',
          })
          expect(
            yield* Effect.promise(() =>
              git(repository.remote, ['rev-parse', 'refs/heads/candidate/test']),
            ),
          ).toBe(remote)
        }),
      ),
  )
}

it.live('preserves divergence when the remote contains unrelated work', () =>
  Effect.gen(function* () {
    const { repository, candidates, issue, prepared } = yield* fixture
    const checkpoint = yield* candidates
      .checkpoint(issue, prepared)
      .pipe(Effect.map(Option.getOrThrow))
    yield* Effect.promise(() => commitFile(repository.seed, 'other.txt', 'other', 'unrelated work'))
    yield* Effect.promise(() =>
      git(repository.seed, ['push', 'origin', 'HEAD:refs/heads/candidate/test']),
    )
    expect((yield* candidates.observe(checkpoint))._tag).toBe('Diverged')
  }),
)
