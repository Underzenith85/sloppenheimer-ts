import { FileSystem } from '@effect/platform'
import { resolve } from 'node:path'
import { Effect, Option, Queue, Ref, Runtime, type Scope } from 'effect'

import type { Issue } from '../domain/domain.js'
import type { WorkflowError } from '../domain/errors.js'
import { logWarning } from '../support/logging.js'
import {
  AgentRunner,
  CurrentCodeReview,
  CurrentSourceControl,
  CurrentTracker,
  CurrentWorkspaceManager,
  WorkflowLoader,
} from '../ports/index.js'
import { noteHandoffOutcome, openDetailRecord, publishDetails } from './detail-records.js'
import {
  hydrateRestoredHandoffs,
  persistHandoffs,
  recoverMissingHandoffs,
  restoreHandoffStore,
} from './handoff-recovery.js'
import { logContext, stateIsIn } from './policy.js'
import { applyLifecycleUpdate, cancelRunning, reconcile } from './run-lifecycle.js'
import type {
  HandoffStoreBinding,
  OrchestratorContext,
  OrchestratorEvent,
  OrchestratorServices,
} from './runtime.js'
import { requestTick, scheduleNextTick, scheduleRetry } from './scheduling.js'
import { initialState, type EffectiveWorkflow, type RuntimePorts } from './state.js'
import * as Transitions from './transitions.js'
import { makeEffectiveWorkflow, rebuildEffectiveWorkflow } from './workflow-reload.js'

/**
 * What a host does before it can take its first pass: bind the ports the composition root
 * supplied, adopt a workflow, clear what the last run left behind, and open the state cell and the
 * mailbox that everything afterwards is stated against.
 */

/**
 * Removes the workspace of every issue that reached a terminal state while the orchestrator was
 * down. It runs before any state exists, and answers only to the tracker and the filesystem.
 */
const cleanupTerminalWorkspaces = (effective: EffectiveWorkflow): Effect.Effect<void> =>
  Effect.gen(function* () {
    const terminalGroups = yield* Effect.forEach(
      effective.workflow.config.tracker.terminalStates,
      (state) =>
        effective.tracker.fetchIssuesByStates([state], null, { hydrateDependencies: false }).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              logWarning('startup terminal issue fetch failed; continuing', {
                state,
                error: error.message,
              }).pipe(Effect.as<readonly Issue[]>([])),
            onSuccess: (issues) => Effect.succeed(issues),
          }),
        ),
      { concurrency: 1 },
    )
    const terminalIssues = [
      ...new Map(terminalGroups.flat().map((issue) => [issue.id, issue])).values(),
    ]
    for (const issue of terminalIssues) {
      const workspaceExists = yield* effective.workspaces.exists(issue.identifier).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            logWarning('startup workspace inspection failed; continuing', {
              ...logContext(issue),
              action: 'workspace_inspection',
              outcome: 'failed',
              error: error.message,
            }).pipe(Effect.as<boolean | null>(null)),
          onSuccess: (exists) => Effect.succeed<boolean | null>(exists),
        }),
      )
      if (workspaceExists !== true) {
        continue
      }
      const refreshed = yield* effective.tracker
        .fetchIssuesByIds([issue.id], { hydrateDependencies: false })
        .pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              logWarning('startup terminal issue recheck failed; continuing', {
                ...logContext(issue),
                action: 'terminal_recheck',
                outcome: 'failed',
                error: error.message,
              }).pipe(Effect.as<readonly Issue[] | null>(null)),
            onSuccess: (issues) => Effect.succeed<readonly Issue[] | null>(issues),
          }),
        )
      const current = refreshed?.find((candidate) => candidate.id === issue.id)
      if (
        current === undefined ||
        !stateIsIn(current.state, effective.workflow.config.tracker.terminalStates)
      ) {
        continue
      }
      yield* effective.workspaces.remove(current.identifier).pipe(
        Effect.catchAll((error) =>
          logWarning('startup terminal workspace cleanup failed; continuing', {
            ...logContext(current),
            action: 'workspace_cleanup',
            outcome: 'failed',
            error: error.message,
          }),
        ),
      )
    }
  })

/**
 * Opens the runtime context: the state cell, the mailbox, and the operations the event loop calls
 * through. Each operation is a module-level function of the context, wired here rather than
 * defined here, so what an operation may reach is stated in its parameters instead of being
 * whatever this scope happened to hold.
 *
 * The record refers to itself, so the operations that carry no arguments of their own are wired
 * through `Effect.suspend`: the reference is taken when the effect runs, by which time the record
 * it names exists.
 */
export const openOrchestratorContext = (
  selectedWorkflowPath: string,
): Effect.Effect<OrchestratorContext, WorkflowError, OrchestratorServices | Scope.Scope> =>
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
     * Bound once here rather than read from each fiber that persists: the runtime hands its own
     * operations out as `Effect<void>` for a callback to run, and those carry no context of their
     * own.
     */
    const fileSystem = yield* FileSystem.FileSystem
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

    const handoffStore: HandoffStoreBinding = {
      path: resolve(bootstrapWorkflow.workflow.config.workspaceRoot, '.symphony', 'handoffs.json'),
      disabled: Option.isNone(bootstrapWorkflow.codeReview),
      fileSystem,
    }
    const restored = yield* restoreHandoffStore(handoffStore)

    const state = yield* Ref.make(
      Transitions.holdRetirements(initialState(bootstrapWorkflow, restored), bootstrap.retirements),
    )
    const mailbox = yield* Queue.unbounded<OrchestratorEvent>()

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

    const context: OrchestratorContext = {
      state,
      ports,
      selectedWorkflowPath,
      mailbox,
      handoffStore,
      detailRecord: (issue, attempt, dispatchLabels) =>
        openDetailRecord(context, issue, attempt, dispatchLabels),
      scheduleRetry: (issue, attempt, error, continuation, trackerError) =>
        scheduleRetry(context, issue, attempt, error, continuation, trackerError),
      applyLifecycleUpdate,
      cancelRunning: (id, cleanupWorkspace, reason) =>
        cancelRunning(context, id, cleanupWorkspace, reason),
      noteHandoffOutcome: (id, handoff, outcome) =>
        noteHandoffOutcome(context, id, handoff, outcome),
      persistHandoffs: Effect.suspend(() => persistHandoffs(context)),
      recoverMissingHandoffs: Effect.suspend(() => recoverMissingHandoffs(context)),
      reconcile: (retryDispatchAllowed) => reconcile(context, retryDispatchAllowed),
      hydrateRestoredHandoffs: Effect.suspend(() => hydrateRestoredHandoffs(context)),
      makeEffectiveWorkflow: (workflow) => makeEffectiveWorkflow(context, workflow),
      scheduleNextTick: Effect.suspend(() => scheduleNextTick(context)),
      requestTick: (source) => requestTick(context, source),
      runFromCallback: (effect) => {
        Runtime.runFork(runtime)(effect, { scope: orchestratorScope })
      },
      publish: Effect.suspend(() => publishDetails(context)),
    }
    return context
  })
