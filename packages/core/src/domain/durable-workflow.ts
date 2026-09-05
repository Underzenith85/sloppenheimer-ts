import { Schema } from 'effect'

/** Durable values are JSON-shaped. Runtime resources never enter these records. */
export const OperationKind = Schema.Literal(
  'prepare',
  'implement',
  'inspect',
  'verify',
  'publish',
  'ensure_pull_request',
  'observe_review',
  'repair',
  'cleanup',
)

export const Operation = Schema.Struct({
  id: Schema.NonEmptyString,
  generation: Schema.Int.pipe(Schema.positive()),
  kind: OperationKind,
  inputRevision: Schema.NonEmptyString,
  attempt: Schema.Int.pipe(Schema.nonNegative()),
  timeoutMs: Schema.Int.pipe(Schema.positive()),
})
export type Operation = typeof Operation.Type

export const Artifact = Schema.Struct({
  id: Schema.NonEmptyString,
  workspacePath: Schema.NonEmptyString,
  workspaceKey: Schema.NonEmptyString,
  baselineSha: Schema.NonEmptyString,
  candidateRevision: Schema.NonEmptyString,
  expectedRemoteHead: Schema.NullOr(Schema.String),
  verifiedRevision: Schema.NullOr(Schema.String),
  publishedHead: Schema.NullOr(Schema.String),
  remoteObservation: Schema.optionalWith(
    Schema.Struct({
      headSha: Schema.NullOr(Schema.String),
      observedAt: Schema.Number,
    }),
    { exact: true },
  ),
  repository: Schema.optionalWith(
    Schema.Struct({
      identity: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
      branchName: Schema.NonEmptyString,
      baseBranch: Schema.NonEmptyString,
      baseSha: Schema.NonEmptyString,
      headSha: Schema.NonEmptyString,
      treeSha: Schema.NullOr(Schema.String),
    }),
    { exact: true },
  ),
})
export type Artifact = typeof Artifact.Type

const active = {
  operation: Operation,
}
export const WorkflowStatus = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal('Queued'), ...active }),
  Schema.Struct({ _tag: Schema.Literal('Executing'), ...active, deadline: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal('Stopping'), ...active, deadline: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal('Reconciling'), ...active }),
  Schema.Struct({ _tag: Schema.Literal('Retrying'), ...active, dueAt: Schema.Number }),
  Schema.Struct({
    _tag: Schema.Literal('Waiting'),
    condition: Schema.Literal('capacity', 'checks', 'review', 'eligibility', 'continuation'),
    deadline: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal('Intervention'), reason: Schema.NonEmptyString }),
  Schema.Struct({ _tag: Schema.Literal('Completed'), headSha: Schema.NonEmptyString }),
)
export type WorkflowStatus = typeof WorkflowStatus.Type

export const DurableWorkflow = Schema.Struct({
  version: Schema.Literal(1),
  issueId: Schema.NonEmptyString,
  identifier: Schema.NonEmptyString,
  objective: Schema.String,
  revision: Schema.Int.pipe(Schema.nonNegative()),
  intent: Schema.Literal('active', 'paused', 'cancelled'),
  afterPublication: Schema.optionalWith(Schema.Literal('review', 'continuation'), { exact: true }),
  owner: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
  status: WorkflowStatus,
  artifact: Schema.NullOr(Artifact),
  codingAttempts: Schema.Int.pipe(Schema.nonNegative()),
  repairAttempts: Schema.Int.pipe(Schema.nonNegative()),
  maximumCodingAttempts: Schema.Int.pipe(Schema.positive()),
  maximumRepairAttempts: Schema.Int.pipe(Schema.nonNegative()),
  budgetDeadline: Schema.Number,
  lastProgressAt: Schema.Number,
  lastFailureSignature: Schema.NullOr(Schema.String),
  repeatedFailures: Schema.Int.pipe(Schema.nonNegative()),
  updatedAt: Schema.Number,
})
export type DurableWorkflow = typeof DurableWorkflow.Type

export const DurableWorkflowJson = Schema.parseJson(DurableWorkflow)
