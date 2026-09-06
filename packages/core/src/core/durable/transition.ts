import type {
  Artifact,
  DurableWorkflow,
  Operation,
  WorkflowStatus,
} from '../../domain/durable-workflow.js'
import type { Issue } from '../../domain/domain.js'
import type { SourceControlTarget } from '../../ports/source-control.js'

/** Production admission is one pure decision; the caller commits this value before launch. */
export const admittedWorkflow = (
  current: DurableWorkflow | undefined,
  issue: Issue,
  target: SourceControlTarget,
  afterPublication: 'review' | 'continuation',
  verificationRequired: boolean,
  now: number,
): DurableWorkflow & Readonly<{ owner: string }> => {
  const repair = target._tag === 'Repair'
  const revision = current === undefined ? 0 : current.revision + 1
  const owner = `${issue.id}:run:${String(revision)}`
  return {
    ...(current?.completion === undefined ? {} : { completion: current.completion }),
    ...(current?.handoff === undefined ? {} : { handoff: current.handoff }),
    version: 1,
    issueId: issue.id,
    identifier: issue.identifier,
    objective: issue.title,
    revision,
    owner,
    intent: 'active',
    verificationRequired,
    afterPublication,
    runTarget: target,
    status: {
      _tag: 'Executing',
      deadline: now + 900_000,
      operation: {
        id: `${owner}:prepare`,
        generation: revision + 1,
        kind: 'prepare',
        inputRevision: repair ? target.expectedHeadSha : owner,
        attempt: 0,
        timeoutMs: 900_000,
      },
    },
    artifact: null,
    codingAttempts: (current?.codingAttempts ?? 0) + (repair ? 0 : 1),
    repairAttempts: (current?.repairAttempts ?? 0) + (repair ? 1 : 0),
    maximumCodingAttempts: current?.maximumCodingAttempts ?? 3,
    maximumRepairAttempts: current?.maximumRepairAttempts ?? 3,
    budgetDeadline: current?.budgetDeadline ?? now + 86_400_000,
    lastProgressAt: now,
    lastFailureSignature: null,
    repeatedFailures: 0,
    updatedAt: now,
  }
}

export type WorkflowEvent =
  | Readonly<{ _tag: 'IntentChanged'; intent: DurableWorkflow['intent'] }>
  | Readonly<{ _tag: 'Started'; operationId: string; generation: number }>
  | Readonly<{ _tag: 'Recovered' }>
  | Readonly<{
      _tag: 'Settled'
      operationId: string
      generation: number
      outcome: 'succeeded' | 'transient_failure' | 'needs_repair' | 'unknown' | 'crashed'
      next: WorkflowStatus
      artifact: Artifact | null
      failureSignature: string | null
    }>

/** Operation identity fences all settlement, including output received after cancellation. */
const belongs = (
  status: WorkflowStatus,
  event: Readonly<{ operationId: string; generation: number }>,
): boolean =>
  'operation' in status &&
  status.operation.id === event.operationId &&
  status.operation.generation === event.generation

const stopped = (workflow: DurableWorkflow, now: number): WorkflowStatus => {
  const status = workflow.status
  return status._tag === 'Executing'
    ? {
        _tag: 'Stopping',
        operation: status.operation,
        deadline: Math.min(status.deadline, now + 10_000),
      }
    : status
}

const settle = (
  workflow: DurableWorkflow,
  event: Extract<WorkflowEvent, { _tag: 'Settled' }>,
  now: number,
): DurableWorkflow => {
  if (
    !belongs(workflow.status, event) ||
    !['Executing', 'Stopping', 'Reconciling'].includes(workflow.status._tag)
  ) {
    return workflow
  }
  const repeats =
    event.failureSignature !== null && event.failureSignature === workflow.lastFailureSignature
      ? workflow.repeatedFailures + 1
      : event.failureSignature === null
        ? 0
        : 1
  const progress =
    event.artifact !== null &&
    event.artifact.candidateRevision !== workflow.artifact?.candidateRevision
  const artifact = event.artifact ?? workflow.artifact
  const unverifiedCompletion =
    event.next._tag === 'Completed' &&
    (artifact === null ||
      artifact.verifiedRevision !== artifact.candidateRevision ||
      artifact.publishedHead !== event.next.headSha)
  const status: WorkflowStatus = unverifiedCompletion
    ? { _tag: 'Intervention', reason: 'Completion requires verified publication evidence' }
    : event.outcome === 'crashed'
      ? { _tag: 'Intervention', reason: 'Worker defect requires investigation' }
      : repeats >= 3
        ? {
            _tag: 'Intervention',
            reason: 'Repeated unchanged failure requires new inputs or intervention',
          }
        : event.outcome === 'unknown' && 'operation' in workflow.status
          ? { _tag: 'Reconciling', operation: workflow.status.operation }
          : event.next
  return {
    ...workflow,
    status,
    // A cancellation changes intent, never erases an observed publication or candidate.
    artifact,
    lastProgressAt: progress ? now : workflow.lastProgressAt,
    lastFailureSignature: event.failureSignature,
    repeatedFailures: repeats,
  }
}

const start = (
  workflow: DurableWorkflow,
  event: Extract<WorkflowEvent, { _tag: 'Started' }>,
  now: number,
): DurableWorkflow => {
  if (
    workflow.intent !== 'active' ||
    workflow.status._tag !== 'Queued' ||
    !belongs(workflow.status, event)
  ) {
    return workflow
  }
  const operation = workflow.status.operation
  if (
    operation.kind === 'publish' &&
    (workflow.artifact === null ||
      workflow.artifact.verifiedRevision !== workflow.artifact.candidateRevision ||
      operation.inputRevision !== workflow.artifact.candidateRevision)
  ) {
    return {
      ...workflow,
      status: {
        _tag: 'Intervention',
        reason: 'Publication requires verification of its exact input',
      },
    }
  }
  const coding = operation.kind === 'implement'
  const repairing = operation.kind === 'repair'
  if (
    now >= workflow.budgetDeadline ||
    (coding && workflow.codingAttempts >= workflow.maximumCodingAttempts) ||
    (repairing && workflow.repairAttempts >= workflow.maximumRepairAttempts)
  ) {
    return {
      ...workflow,
      status: { _tag: 'Intervention', reason: 'Issue execution budget exhausted' },
    }
  }
  return {
    ...workflow,
    status: { _tag: 'Executing', operation, deadline: now + operation.timeoutMs },
    codingAttempts: workflow.codingAttempts + (coding ? 1 : 0),
    repairAttempts: workflow.repairAttempts + (repairing ? 1 : 0),
  }
}

export const transitionWorkflow = (
  workflow: DurableWorkflow,
  event: WorkflowEvent,
  now: number,
): DurableWorkflow => {
  let next: DurableWorkflow
  switch (event._tag) {
    case 'IntentChanged': {
      if (workflow.intent === event.intent) {
        return workflow
      }
      next = {
        ...workflow,
        intent: event.intent,
        status: event.intent === 'active' ? workflow.status : stopped(workflow, now),
      }
      break
    }
    case 'Started': {
      next = start(workflow, event, now)
      break
    }
    case 'Settled': {
      next = settle(workflow, event, now)
      break
    }
    case 'Recovered': {
      next =
        workflow.status._tag === 'Executing' || workflow.status._tag === 'Stopping'
          ? { ...workflow, status: { _tag: 'Reconciling', operation: workflow.status.operation } }
          : workflow
      break
    }
  }
  return next === workflow ? workflow : { ...next, revision: workflow.revision + 1, updatedAt: now }
}

/** Retry the operation with a new generation, keeping its logical identity and original inputs. */
export const retryOperation = (operation: Operation): Operation => ({
  ...operation,
  generation: operation.generation + 1,
  attempt: operation.attempt + 1,
})
