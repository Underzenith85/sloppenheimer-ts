import { settleRun } from './settlement.js'
import { Clock, Effect, Option } from 'effect'
import type { Artifact, DurableWorkflow } from '../../domain/durable-workflow.js'
import type { Candidate, CandidateJournal } from '../../ports/candidate.js'
import type { PreparedRepository, PublicationOutcome } from '../../ports/source-control.js'
import type { PostflightOutcome } from '../postflight.js'

export type RunJournal = Readonly<{
  prepared: (prepared: PreparedRepository) => Effect.Effect<void>
  publication: CandidateJournal
  settled: (outcome: PostflightOutcome) => Effect.Effect<void>
  failed: Effect.Effect<void>
}>

const preparedArtifact = (prepared: PreparedRepository): Artifact => ({
  id: prepared.workspace.key,
  workspacePath: prepared.workspace.path,
  workspaceKey: prepared.workspace.key,
  baselineSha: prepared.baselineSha,
  candidateRevision: prepared.baselineSha,
  expectedRemoteHead: Option.getOrNull(prepared.expectedRemoteHead),
  verifiedRevision: null,
  publishedHead: null,
  repository: {
    branchName: prepared.target.branchName,
    baseBranch: prepared.baseBranch,
    baseSha: prepared.baseSha,
    headSha: prepared.baselineSha,
    treeSha: null,
  },
})

const candidateArtifact = (candidate: Candidate): Artifact => ({
  ...preparedArtifact(candidate.prepared),
  candidateRevision: candidate.treeSha,
  repository: {
    branchName: candidate.prepared.target.branchName,
    baseBranch: candidate.prepared.baseBranch,
    baseSha: candidate.prepared.baseSha,
    headSha: candidate.headSha,
    treeSha: candidate.treeSha,
  },
})

export type Writer = (
  issueId: string,
  update: (current: DurableWorkflow) => DurableWorkflow,
  owner?: string,
  requireActive?: boolean,
) => Effect.Effect<void>

export const journalFor = (write: Writer, issueId: string, owner: string): RunJournal => {
  const owned = (update: (current: DurableWorkflow) => DurableWorkflow): Effect.Effect<void> =>
    write(issueId, update, owner)
  const phase = (
    kind: 'implement' | 'inspect' | 'verify' | 'publish',
    artifact?: Artifact,
    requireActive = true,
  ): Effect.Effect<void> =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        write(
          issueId,
          (current) => ({
            ...current,
            artifact: artifact ?? current.artifact,
            status: {
              _tag: 'Executing',
              deadline: now + 900_000,
              operation: {
                id: owner + ':' + kind,
                kind,
                generation: current.revision + 1,
                attempt: 0,
                inputRevision:
                  artifact?.candidateRevision ?? current.artifact?.candidateRevision ?? owner,
                timeoutMs: 900_000,
              },
            },
          }),
          owner,
          requireActive,
        ),
      ),
    )
  const settled = (outcome: PostflightOutcome | PublicationOutcome): Effect.Effect<void> =>
    owned((current) => settleRun(current, outcome))
  return {
    prepared: (prepared) => phase('implement', preparedArtifact(prepared)),
    publication: {
      checkpointing: phase('inspect'),
      checkpointed: (candidate) => phase('inspect', candidateArtifact(candidate)),
      aligned: (candidate) => phase('verify', candidateArtifact(candidate)),
      verified: (verified) =>
        phase(
          'publish',
          {
            ...candidateArtifact(verified.candidate),
            verifiedRevision: verified.evidence.treeSha,
          },
          false,
        ),
      published: settled,
    },
    settled,
    failed: owned((current) => ({
      ...current,
      status: {
        _tag: 'Intervention',
        reason: 'Execution ended before durable settlement; inspect retained work',
      },
    })),
  }
}
