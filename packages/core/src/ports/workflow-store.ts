import { Context, type Effect, type Option } from 'effect'

import type { DurableWorkflow } from '../domain/durable-workflow.js'
import type { WorkflowStoreError } from '../domain/errors.js'

/**
 * Commit is compare-and-swap. The queued operation is the outbox entry, committed in the same
 * transaction as its workflow. A stale writer never overwrites a successor's intent.
 */
export type WorkflowStorePort = Readonly<{
  get: (issueId: string) => Effect.Effect<Option.Option<DurableWorkflow>, WorkflowStoreError>
  list: Effect.Effect<readonly DurableWorkflow[], WorkflowStoreError>
  commit: (
    workflow: DurableWorkflow,
    expectedRevision: number | null,
  ) => Effect.Effect<void, WorkflowStoreError>
}>

export class WorkflowStore extends Context.Tag('sloppenheimer/WorkflowStore')<
  WorkflowStore,
  WorkflowStorePort
>() {}
