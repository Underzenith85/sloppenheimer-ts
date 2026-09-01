import { Effect, Ref } from 'effect'

import type { WorkflowError } from '../../domain/errors.js'
import type { Workflow } from '../../config/workflow.js'
import type { EffectiveWorkflow, RuntimePorts } from '../state.js'
import * as Transitions from '../transitions.js'
import { rebuildEffectiveWorkflow } from '../workflow-reload.js'
import { abandonDelivery, resumeDelivery, scheduleDelivery, suspendDelivery } from './deliveries.js'
import { hydrateRestoredHandoffs, recoverMissingHandoffs } from './handoff-recovery.js'
import { reconcile } from './reconcile.js'
import {
  applyLifecycleUpdate,
  cancelRunning,
  noteHandoffOutcome,
  openDetailRecord,
} from './runs.js'
import { requestTick, scheduleNextTick, scheduleRetry } from './scheduling.js'
import { persistCompletions, persistHandoffs } from './store.js'
import type { OrchestratorContext, RuntimeCells } from './types.js'

/**
 * Rebuilds the ports for a workflow and adopts it, recording the instances it displaced.
 *
 * The retirements are recorded before the outcome is raised: a rebuild that refused partway through
 * has still displaced whatever the cells it did reach were holding.
 */
export const makeEffectiveWorkflow = (
  cells: RuntimeCells,
  ports: RuntimePorts,
  workflow: Workflow,
): Effect.Effect<EffectiveWorkflow, WorkflowError> =>
  rebuildEffectiveWorkflow(ports, workflow).pipe(
    Effect.tap((rebuilt) =>
      Ref.update(cells.state, (current) =>
        Transitions.holdRetirements(current, rebuilt.retirements),
      ),
    ),
    Effect.flatMap((rebuilt) => rebuilt.value),
  )

/**
 * Binds every runtime operation to the cells the factory made, and hands them out as one record.
 *
 * Each field is a module-level function partially applied here rather than a closure over the
 * factory's scope, so an operation can be read, tested and changed on its own.
 */
export const orchestratorContext = (
  cells: RuntimeCells,
  ports: RuntimePorts,
  selectedWorkflowPath: string,
  runFromCallback: (effect: Effect.Effect<void>) => void,
): OrchestratorContext => ({
  state: cells.state,
  ports,
  selectedWorkflowPath,
  mailbox: cells.mailbox,
  detailRecord: (issue, attempt, dispatchLabels) =>
    openDetailRecord(cells, issue, attempt, dispatchLabels),
  scheduleRetry: (issue, attempt, error, continuation, repairRun, trackerError) =>
    scheduleRetry(cells, issue, attempt, error, continuation, repairRun, trackerError),
  scheduleDelivery: (request) => scheduleDelivery(cells, request),
  abandonDelivery: (id, reason) => abandonDelivery(cells, id, reason),
  suspendDelivery: (id, reason) => suspendDelivery(cells, id, reason),
  resumeDelivery: (entry) => resumeDelivery(cells, entry),
  applyLifecycleUpdate,
  cancelRunning: (id, cleanupWorkspace, reason) =>
    cancelRunning(cells, id, cleanupWorkspace, reason),
  noteHandoffOutcome: (id, handoff, outcome) => noteHandoffOutcome(cells, id, handoff, outcome),
  persistHandoffs: persistHandoffs(cells),
  persistCompletions: persistCompletions(cells),
  recoverMissingHandoffs: recoverMissingHandoffs(cells),
  reconcile: (retryDispatchAllowed) => reconcile(cells, retryDispatchAllowed),
  hydrateRestoredHandoffs: hydrateRestoredHandoffs(cells),
  makeEffectiveWorkflow: (workflow) => makeEffectiveWorkflow(cells, ports, workflow),
  scheduleNextTick: scheduleNextTick(cells),
  requestTick: (source) => requestTick(cells, source),
  runFromCallback,
  publish: Ref.update(cells.state, Transitions.publishDetails),
})
