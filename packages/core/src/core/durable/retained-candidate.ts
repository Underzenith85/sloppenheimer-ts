/**
 * What a retained checkout is allowed to become, decided by looking at the checkout rather than by
 * trusting the diagnostic the stopped host left behind.
 *
 * A legacy publication or rebase failure may have invalidated the verification evidence, or never
 * persisted any, so nothing here reads `verifiedRevision` as a statement about the working tree.
 * The candidate head and the worktree's cleanliness are inspected now; evidence that does not name
 * the tree the recorded candidate carries proves nothing and never becomes a candidate identity.
 * What an inspection cannot settle — the candidate's tree, and its ancestry from the recorded
 * baseline — is earned again by the checkpoint the recovery delivery runs, which is why a record
 * without proven evidence is resumed with no retained candidate rather than with an invented one.
 *
 * Every way the checkout fails to answer is a reason an operator reads on the record, never an
 * absence they have to account for themselves.
 */
import { Effect, type Option } from 'effect'

import type { Artifact, DurableWorkflow } from '../../domain/durable-workflow.js'
import type { PreparedRepository, SourceControlPort } from '../../ports/source-control.js'

/** The candidate provenance a record carries once its preparation has been journalled. */
export type RepositoryProvenance = NonNullable<Artifact['repository']>

export type RetainedAssessment =
  | Readonly<{ _tag: 'Resumable'; prepared: PreparedRepository }>
  | Readonly<{ _tag: 'Refused'; reason: string }>

/** What the record proves about its own candidate, and the remote facts observed against it. */
export type RetainedInspection = Readonly<{
  record: DurableWorkflow
  artifact: Artifact
  repository: RepositoryProvenance
  observedHead: Option.Option<string>
  observedBaseSha: string
}>

export const refused = (reason: string): RetainedAssessment => ({ _tag: 'Refused', reason })

/**
 * The tree the record proves its candidate commit carried, or `null` when it proves none.
 *
 * A failure that left `verifiedRevision` null, or left it naming a tree the recorded candidate no
 * longer carries, is not current verification and is never treated as any.
 */
export const provenTree = (artifact: Artifact, repository: RepositoryProvenance): string | null =>
  artifact.verifiedRevision !== null && artifact.verifiedRevision === repository.treeSha
    ? artifact.verifiedRevision
    : null

const preparedFrom = (inspection: RetainedInspection): PreparedRepository => {
  const { record, artifact, repository } = inspection
  const tree = provenTree(artifact, repository)
  return {
    workspace: { path: artifact.workspacePath, key: artifact.workspaceKey },
    target: record.runTarget ?? { _tag: 'Normal', branchName: repository.branchName },
    baseBranch: repository.baseBranch,
    baseSha: inspection.observedBaseSha,
    baselineSha: artifact.baselineSha,
    // The fresh recovery owns the exact head it just observed, not the lease the legacy
    // publication captured before the host stopped.
    expectedRemoteHead: inspection.observedHead,
    ...(tree === null
      ? {}
      : {
          retainedCandidate: { headSha: repository.headSha, treeSha: tree, commitCreated: false },
        }),
    ...(repository.identity === undefined ? {} : { repositoryIdentity: repository.identity }),
  }
}

/**
 * Reads the retained workspace once, and answers with the preparation a recovery may mutate under
 * or with the reason it may not. Nothing is written and nothing is published from here.
 */
export const assessRetainedCandidate = (
  sourceControl: SourceControlPort,
  inspection: RetainedInspection,
): Effect.Effect<RetainedAssessment> =>
  Effect.gen(function* () {
    const prepared = preparedFrom(inspection)
    const key = inspection.artifact.workspaceKey
    // The inspection is also what proves no orphaned rebase sequencer is paused in the checkout.
    const inspected = yield* Effect.either(sourceControl.inspect(prepared))
    if (inspected._tag === 'Left') {
      return refused(
        `Retained workspace ${key} could not be inspected (${inspected.left.category}): ${inspected.left.message}`,
      )
    }
    const worktree = inspected.right
    if (worktree._tag === 'Clean' || !worktree.committedAhead) {
      return refused(
        `Retained workspace ${key} carries no commit the observed remote head lacks; no recovery mutation was admitted.`,
      )
    }
    if (worktree.dirtyFileCount > 0) {
      return refused(
        `Retained workspace ${key} has ${String(worktree.dirtyFileCount)} uncommitted path(s); its candidate is ambiguous and no recovery mutation was admitted.`,
      )
    }
    const retained = prepared.retainedCandidate
    if (retained !== undefined && retained.headSha !== worktree.headSha) {
      return refused(
        `Retained workspace ${key} is at ${worktree.headSha} rather than the verified candidate ${retained.headSha}; candidate identity could not be established.`,
      )
    }
    return { _tag: 'Resumable', prepared }
  })
