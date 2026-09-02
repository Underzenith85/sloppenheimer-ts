import { Effect, Queue, Ref, Runtime, Stream, type Scope } from 'effect'

import type { WorkflowError } from '../domain/errors.js'
import {
  AgentRunner,
  CurrentCodeReview,
  CurrentSourceControl,
  CurrentTracker,
  CurrentWorkspaceManager,
  WorkflowLoader,
  WorkflowWatcher,
} from '../ports/index.js'
import { eventLoop } from './polling.js'
import { initialState, type RuntimePorts } from './state.js'
import * as Transitions from './transitions.js'
import { rebuildEffectiveWorkflow } from './workflow-reload.js'
import { orchestratorContext } from './runtime/context.js'
import { orchestratorControl } from './runtime/control.js'
import { hydrateRestoredHandoffs } from './runtime/handoff-recovery.js'
import { requestTick } from './runtime/scheduling.js'
import { cleanupTerminalWorkspaces } from './runtime/startup.js'
import { openStores } from './runtime/store.js'
import { openTraceStore } from './runtime/traces.js'
import type {
  OrchestratorControl,
  OrchestratorEvent,
  OrchestratorServices,
  RuntimeCells,
} from './runtime/types.js'

/**
 * The orchestrator's assembly, and nothing else.
 *
 * Every operation the running host performs lives in a module under `runtime/`, taking the cells it
 * needs as a parameter rather than closing over this factory's scope:
 *
 * - `runtime/types.ts` — the wire and context types, and the cells the operations are handed.
 * - `runtime/startup.ts` — the terminal-workspace sweep that runs before any state exists.
 * - `runtime/store.ts` — binding, reading and writing the persisted handoff and completion stores.
 * - `runtime/traces.ts` — the durable high-fidelity agent trace, and `runtime/trace-reader.ts` the
 *   paged read of it.
 * - `runtime/handoff-recovery.ts` — restoring persisted handoffs and adopting unrecorded ones.
 * - `runtime/runs.ts` — opening a detail record, applying a protocol event, cancelling a run.
 * - `runtime/scheduling.ts` — ticks, refresh requests, the poll timer and retry scheduling.
 * - `runtime/deliveries.ts` — queueing and abandoning work that is waiting to reach the remote.
 * - `runtime/reconcile.ts` — bringing the live runs back into agreement with the tracker.
 * - `runtime/context.ts` — binding all of them to the cells, as the context the event loop reads.
 * - `runtime/control.ts` — the handle the composition root holds.
 */

export { type DeliveryEntry, type PostflightOutcome } from './postflight.js'

export {
  publishedCompletedWork,
  type AgentDetailLookup,
  type CompletedSnapshot,
  type DeliveryAttemptResult,
  type DeliveryRequest,
  type DeliverySnapshot,
  type OrchestratorContext,
  type OrchestratorControl,
  type OrchestratorEvent,
  type OrchestratorServices,
  type OrchestratorSnapshot,
  type RefreshOutcome,
  type RetrySnapshot,
  type RunningSnapshot,
  type RuntimeCells,
  type RuntimeStore,
  type RuntimeStores,
  type TracePage,
  type TraceQuery,
  type TraceRecorder,
} from './runtime/types.js'

export { tracePageLimit, traceQuery } from './runtime/trace-reader.js'

export {
  completionWindowMs,
  retainedCompletedDetails,
  type CompletedEntry,
  type EffectiveWorkflow,
  type ExecutionSnapshot,
  type HandoffEntry,
  type HandoffRecoveryCounts,
  type HandoffStoreError,
  type PendingRetirement,
  type PublishedDetail,
  type RefreshOperation,
  type RetryEntry,
  type RunningEntry,
  type RuntimePorts,
  type RuntimeState,
  type WorkflowReloadError,
} from './state.js'
export { issueIsRoutable, sortIssues } from './policy.js'

export const startOrchestratorRuntime = (
  selectedWorkflowPath: string,
): Effect.Effect<OrchestratorControl, WorkflowError, OrchestratorServices | Scope.Scope> =>
  Effect.gen(function* () {
    const ports: RuntimePorts = {
      agentRunner: yield* AgentRunner,
      workflowLoader: yield* WorkflowLoader,
      trackerCell: yield* CurrentTracker,
      workspaceCell: yield* CurrentWorkspaceManager,
      codeReviewCell: yield* Effect.serviceOption(CurrentCodeReview),
      sourceControlCell: yield* Effect.serviceOption(CurrentSourceControl),
    }
    /**
     * Built from the workflow the orchestrator loaded rather than adopted from the composition
     * root's own read of it. The two are separate reads of one file, and an edit between them would
     * otherwise leave every port serving a version that nothing compares against again: the reload
     * check measures the file against the workflow adopted here, never against the cells' input.
     * The instances the layer built are replaced immediately and retired on the first poll.
     */
    const bootstrap = yield* rebuildEffectiveWorkflow(
      ports,
      yield* ports.workflowLoader.load(selectedWorkflowPath),
    )
    // A bootstrap that refuses takes the whole host down with it, so whatever it replaced is
    // released by the composition root's own scope rather than by a drain that never runs.
    const bootstrapWorkflow = yield* bootstrap.value
    yield* cleanupTerminalWorkspaces(bootstrapWorkflow)

    const opened = yield* openStores(bootstrapWorkflow)
    const traces = yield* openTraceStore(bootstrapWorkflow.workflow.config.trace)
    const cells: RuntimeCells = {
      state: yield* Ref.make(
        Transitions.holdRetirements(
          initialState(bootstrapWorkflow, opened.restored),
          bootstrap.retirements,
        ),
      ),
      mailbox: yield* Queue.unbounded<OrchestratorEvent>(),
      stores: opened.stores,
      traces,
    }

    /**
     * The one bridge left from a plain callback into the runtime: an agent runner reports progress
     * synchronously, and what the report owes the run — the telemetry it buffers and the mailbox
     * event it raises — has to be applied from there. The runtime is captured once here rather than
     * re-derived per call, and the fork is attached to the orchestrator's scope, so work in flight
     * is interrupted with the orchestrator instead of outliving it.
     *
     * The effect a caller hands this must be one that completes without suspending — a state update
     * and an offer to an unbounded queue — because the fork starts immediately and the callback's
     * caller is entitled to assume the report has landed by the time it returns.
     */
    const runtime = yield* Effect.runtime<never>()
    const orchestratorScope = yield* Effect.scope
    const context = orchestratorContext(cells, ports, selectedWorkflowPath, (effect) => {
      Runtime.runFork(runtime)(effect, { scope: orchestratorScope })
    })

    yield* hydrateRestoredHandoffs(cells)
    yield* context.publish

    // The watcher is installed before startup continues; only its consumption is forked, into the
    // orchestrator's scope, so the tick a change requests is interrupted on shutdown rather than
    // left running against a stopped orchestrator.
    const workflowWatcher = yield* WorkflowWatcher
    const workflowChanges = yield* workflowWatcher.changes(selectedWorkflowPath)
    yield* Effect.forkScoped(Stream.runForEach(workflowChanges, () => requestTick(cells, 'change')))

    const eventLoopFiber = yield* Effect.forkScoped(eventLoop(context))
    yield* requestTick(cells, 'startup')
    return orchestratorControl(cells, context, eventLoopFiber)
  })

export const runOrchestratorRuntime = (
  selectedWorkflowPath: string,
): Effect.Effect<void, WorkflowError, OrchestratorServices> =>
  Effect.scoped(
    // Workers are forked into this scope, and each one's interruption waits on a bounded agent
    // teardown. Closing them concurrently keeps the cost of shutdown independent of how many
    // agents were running, which is what lets the CLI's watchdog stay a last-resort path.
    Effect.parallelFinalizers(
      startOrchestratorRuntime(selectedWorkflowPath).pipe(
        Effect.flatMap((orchestrator) => orchestrator.awaitTermination),
      ),
    ),
  )
