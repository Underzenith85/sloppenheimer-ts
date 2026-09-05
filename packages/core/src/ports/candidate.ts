import type { Effect, Option } from 'effect'

import type { Issue } from '../domain/domain.js'
import type { SourceControlError } from '../domain/errors.js'
import type { PreparedRepository, PublicationOutcome } from './source-control.js'

export type VerificationConfig = Readonly<{
  command: string
  timeoutMs: number
}>

/** Immutable local commit and content identity; the prepared record retains its original lease. */
export type Candidate = Readonly<{
  prepared: PreparedRepository
  headSha: string
  treeSha: string
  commitCreated: boolean
}>

export type VerifiedCandidate = Readonly<{
  candidate: Candidate
  evidence: Readonly<{
    headSha: string
    treeSha: string
    command: string
    verifiedAt: number
  }>
}>

export type CandidateObservation =
  | Readonly<{ _tag: 'Published'; headSha: string }>
  | Readonly<{ _tag: 'Unpublished' }>
  | Readonly<{ _tag: 'Diverged'; remoteHead: string | null }>

/** Each operation is independently supervisable and never launches a coding agent. */
export type CandidateSourceControlPort = Readonly<{
  checkpoint: (
    issue: Issue,
    prepared: PreparedRepository,
    includeBaseline?: boolean,
  ) => Effect.Effect<Option.Option<Candidate>, SourceControlError>
  align: (candidate: Candidate) => Effect.Effect<Candidate, SourceControlError>
  verify: (
    candidate: Candidate,
    configuration: VerificationConfig,
    secretEnvironmentNames: readonly string[],
  ) => Effect.Effect<VerifiedCandidate, SourceControlError>
  observe: (candidate: Candidate) => Effect.Effect<CandidateObservation, SourceControlError>
  publish: (verified: VerifiedCandidate) => Effect.Effect<PublicationOutcome, SourceControlError>
}>

/** Persistence barriers used by the live scheduler; no remote mutation precedes its barrier. */
export type CandidateJournal = Readonly<{
  checkpointing: Effect.Effect<void>
  checkpointed: (candidate: Candidate) => Effect.Effect<void>
  aligned: (candidate: Candidate) => Effect.Effect<void>
  verified: (candidate: VerifiedCandidate) => Effect.Effect<void>
  published: (outcome: PublicationOutcome) => Effect.Effect<void>
}>
