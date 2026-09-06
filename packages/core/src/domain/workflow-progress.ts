import type { DurableWorkflow } from './durable-workflow.js'

/** Operator progress derives from committed facts, including waits with no live worker. */
export const workflowProgress = (
  record: DurableWorkflow,
): Readonly<{
  stage: string
  cleanup_state: string | null
  cleanup_reason: string | null
  cleanup_due_at: number | null
  wait_reason: string | null
  operation_id: string | null
  operation_deadline: number | null
  last_progress_at: number
  verified_revision: string | null
  coding_attempts: number
  maximum_coding_attempts: number
  repair_attempts: number
  maximum_repair_attempts: number
  transport_failures: number
  budget_deadline: number
  next_action: string
}> => {
  const status = record.status
  const operation = 'operation' in status ? status.operation : null
  const external = record.externalOperation?.outcome === 'pending' ? record.externalOperation : null
  const stage = external?.kind ?? operation?.kind ?? record.handoff?.state ?? status._tag
  const cleanup = record.cleanup
  return {
    stage,
    cleanup_state: cleanup?.state ?? null,
    cleanup_reason: cleanup?.reason ?? null,
    cleanup_due_at: cleanup?.dueAt ?? null,
    wait_reason:
      status._tag === 'Waiting'
        ? status.condition
        : status._tag === 'Intervention'
          ? status.reason
          : null,
    operation_id: external?.id ?? operation?.id ?? null,
    operation_deadline: external?.deadline ?? ('deadline' in status ? status.deadline : null),
    last_progress_at: record.lastProgressAt,
    verified_revision: record.artifact?.verifiedRevision ?? null,
    coding_attempts: record.codingAttempts,
    maximum_coding_attempts: record.maximumCodingAttempts,
    repair_attempts: record.repairAttempts,
    maximum_repair_attempts: record.maximumRepairAttempts,
    transport_failures: record.repeatedFailures,
    budget_deadline: record.budgetDeadline,
    next_action:
      cleanup !== undefined && cleanup.state !== 'completed'
        ? cleanup.state === 'intervention'
          ? `Inspect retained workspace: ${cleanup.reason ?? 'cleanup budget exhausted'}`
          : `Retry captured workspace cleanup at ${String(cleanup.dueAt)}`
        : record.intent !== 'active'
          ? `Hold work while intent is ${record.intent}`
          : status._tag === 'Intervention'
            ? status.reason
            : status._tag === 'Completed'
              ? 'No further implementation work'
              : status._tag === 'Waiting'
                ? `Recheck ${status.condition} by the recorded deadline`
                : status._tag === 'Reconciling'
                  ? 'Inspect local and remote evidence before repeating'
                  : `Settle ${stage} before advancing`,
  }
}
