import { Effect, Option } from 'effect'

import { sameTrackerProvider } from '../config/tracker-config.js'
import type { Workflow } from '../config/workflow.js'
import { WorkflowError } from '../errors.js'
import { portsConfiguration, type AdapterCell, type CodeReviewPort } from '../ports/index.js'
import type {
  EffectiveWorkflow,
  ExecutionSnapshot,
  OrchestratorContext,
  PendingRetirement,
  RuntimePorts,
} from './runtime.js'

const portConfigurationError = (cause: unknown): WorkflowError =>
  cause instanceof WorkflowError
    ? cause
    : new WorkflowError({
        category: 'invalid_config',
        message: 'application ports could not be configured',
        cause,
      })

/** What an operator is owed when handoff is enabled and the provider cannot serve it. */
const handoffCapabilityMissing = (workflow: Workflow): WorkflowError =>
  new WorkflowError({
    category: 'invalid_config',
    message: `pull-request handoff is enabled, but tracker provider ${workflow.tracker.kind} does not supply CodeReviewPort`,
  })

const requireCapability = (
  workflow: Workflow,
  port: CodeReviewPort | null,
): Effect.Effect<CodeReviewPort | null, WorkflowError> =>
  port === null ? Effect.fail(handoffCapabilityMissing(workflow)) : Effect.succeed(port)

/**
 * Records an instance a rebuild replaced, so it is released once the last live holder lets go.
 * An instance that never existed has no holder to wait for.
 */
const noteReplaced = (
  pending: PendingRetirement[],
  kind: PendingRetirement['kind'],
  instance: unknown,
  retire: Effect.Effect<void>,
): Effect.Effect<void> =>
  instance === null
    ? retire
    : Effect.sync(() => {
        pending.push({ kind, instance, retire })
      })

/**
 * Rebuilds one cell and pairs the instance it replaced with the release that retires it.
 *
 * The instance is read from the cell rather than taken from the caller's effective workflow: a
 * dispatch preflighting a handoff's own workflow rebuilds against that snapshot, and what the cell
 * releases is whatever it currently holds. Every rebuild runs on the orchestrator's event loop, so
 * nothing installs a replacement between the read and the rebuild.
 */
const rebuildCell = <Value, Input, BuildError>(
  cell: AdapterCell<Value, Input, BuildError>,
  kind: PendingRetirement['kind'],
  pending: PendingRetirement[],
  input: Input,
): Effect.Effect<Value, BuildError> =>
  cell.get.pipe(
    Effect.flatMap((replaced) =>
      cell.rebuild(input).pipe(
        Effect.tap((rebuilt) => noteReplaced(pending, kind, replaced, rebuilt.retirePrevious)),
        Effect.map((rebuilt) => rebuilt.value),
      ),
    ),
  )

const rebuildCodeReview = (
  ports: RuntimePorts,
  pending: PendingRetirement[],
  workflow: Workflow,
): Effect.Effect<CodeReviewPort | null, WorkflowError> =>
  Option.match(ports.codeReviewCell, {
    onNone: () => Effect.succeed<CodeReviewPort | null>(null),
    onSome: (cell) =>
      rebuildCell(cell, 'codeReview', pending, workflow.tracker).pipe(
        Effect.mapError(portConfigurationError),
        Effect.flatMap((port) => requireCapability(workflow, port)),
      ),
  })

/**
 * Adopts the instances the composition root already built.
 *
 * The layer's configuration and the workflow the orchestrator loads are read from the same file, so
 * the first effective workflow takes the cells as they stand rather than replacing three identical
 * instances before the first poll can use them.
 */
export const adoptInitialPorts = (
  ports: RuntimePorts,
  workflow: Workflow,
): Effect.Effect<EffectiveWorkflow, WorkflowError> =>
  Effect.gen(function* () {
    const codeReview = yield* Option.match(ports.codeReviewCell, {
      onNone: () => Effect.succeed<CodeReviewPort | null>(null),
      onSome: (cell) => cell.get.pipe(Effect.flatMap((port) => requireCapability(workflow, port))),
    })
    return {
      workflow,
      tracker: yield* ports.trackerCell.get,
      codeReview,
      workspaces: yield* ports.workspaceCell.get,
      loadedAt: new Date(),
    }
  })

/**
 * Builds every rebuildable port from a workflow that has just been reloaded. All three are replaced
 * together: a reload can move the workspace root or change a hook as readily as it can change the
 * tracker provider.
 */
export const rebuildEffectiveWorkflow = (
  ports: RuntimePorts,
  pending: PendingRetirement[],
  workflow: Workflow,
): Effect.Effect<EffectiveWorkflow, WorkflowError> =>
  Effect.gen(function* () {
    const tracker = yield* rebuildCell(
      ports.trackerCell,
      'tracker',
      pending,
      workflow.tracker,
    ).pipe(Effect.mapError(portConfigurationError))
    const codeReview = yield* rebuildCodeReview(ports, pending, workflow)
    const workspaces = yield* rebuildCell(
      ports.workspaceCell,
      'workspaces',
      pending,
      portsConfiguration(workflow).workspaces,
    )
    return { workflow, tracker, codeReview, workspaces, loadedAt: new Date() }
  })

/**
 * Re-reads the tracker credentials the workflow references and, when they have changed, rebuilds
 * the two ports that were constructed from them. The workspace manager is untouched: nothing about
 * it is derived from a credential.
 */
export const revalidateCredentials = (
  context: OrchestratorContext,
  effective: EffectiveWorkflow,
): Effect.Effect<EffectiveWorkflow, WorkflowError> =>
  context.ports.workflowLoader.preflight(effective.workflow).pipe(
    Effect.flatMap((validated) => {
      if (sameTrackerProvider(validated, effective.workflow.tracker)) {
        return Effect.succeed(effective)
      }
      const workflow: Workflow = { ...effective.workflow, tracker: validated }
      return Effect.gen(function* () {
        const tracker = yield* rebuildCell(
          context.ports.trackerCell,
          'tracker',
          context.pendingRetirements,
          validated,
        ).pipe(Effect.mapError(portConfigurationError))
        const codeReview = yield* rebuildCodeReview(
          context.ports,
          context.pendingRetirements,
          workflow,
        )
        return { ...effective, workflow, tracker, codeReview }
      })
    }),
  )

const heldInstances = (
  context: OrchestratorContext,
  select: (execution: ExecutionSnapshot) => unknown,
): readonly unknown[] => [
  ...[...context.state.running.values()].map((entry) => select(entry.execution)),
  ...[...context.state.handoffs.values()].map((entry) => select(entry.execution)),
]

const stillHeld = (context: OrchestratorContext, retirement: PendingRetirement): boolean => {
  switch (retirement.kind) {
    case 'tracker': {
      return (
        context.lastKnownGood.tracker === retirement.instance ||
        heldInstances(context, (execution) => execution.tracker).includes(retirement.instance)
      )
    }
    case 'codeReview': {
      return (
        context.lastKnownGood.codeReview === retirement.instance ||
        heldInstances(context, (execution) => execution.codeReview).includes(retirement.instance)
      )
    }
    case 'workspaces': {
      return (
        context.lastKnownGood.workspaces === retirement.instance ||
        heldInstances(context, (execution) => execution.workspaces).includes(retirement.instance)
      )
    }
  }
}

/**
 * Releases every replaced instance that no live work still holds. A worker that captured the
 * previous instance in its execution snapshot keeps it until that run ends, so the rest wait for a
 * later pass; anything never retired is released when the cell's scope closes.
 */
export const drainRetirements = (context: OrchestratorContext): Effect.Effect<void> =>
  Effect.suspend(() => {
    const pending = context.pendingRetirements.splice(0)
    const held = pending.filter((retirement) => stillHeld(context, retirement))
    context.pendingRetirements.push(...held)
    return Effect.forEach(
      pending.filter((retirement) => !held.includes(retirement)),
      (retirement) => retirement.retire,
      { discard: true },
    )
  })

/**
 * Moves live work onto the replacements. A running worker and an in-flight handoff each hold the
 * instances their run started with, so a rebuilt tracker reaches them only here — without this, a
 * rotated credential would never take effect for work already in flight.
 */
export const adoptPorts = (
  context: OrchestratorContext,
  previous: EffectiveWorkflow,
  next: EffectiveWorkflow,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    for (const entry of [...context.state.running.values(), ...context.state.handoffs.values()]) {
      if (entry.execution.tracker === previous.tracker) {
        entry.execution = Object.freeze({
          ...entry.execution,
          tracker: next.tracker,
          codeReview:
            entry.execution.codeReview === previous.codeReview
              ? next.codeReview
              : entry.execution.codeReview,
          secretEnvironmentNames: Object.freeze([...next.tracker.secretEnvironmentNames]),
        })
      }
    }
    return drainRetirements(context)
  })
