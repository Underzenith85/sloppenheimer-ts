import { Effect, MutableRef, Option, Ref } from 'effect'

import { sameTrackerProvider } from '../domain/tracker-provider.js'
import type { Workflow } from '../config/workflow.js'
import { WorkflowError } from '../errors.js'
import { portsConfiguration, type AdapterCell, type CodeReviewPort } from '../ports/index.js'
import type { OrchestratorContext } from './runtime.js'
import type {
  EffectiveWorkflow,
  ExecutionSnapshot,
  PendingRetirement,
  RuntimePorts,
  RuntimeState,
} from './state.js'
import * as Transitions from './transitions.js'

/**
 * A rebuild's result: the ports it produced, and the instances it replaced. The retirements are
 * handed back rather than written anywhere, so rebuilding stays a function of its inputs and the
 * caller decides when they enter the state.
 */
export type RebuiltWorkflow = Readonly<{
  value: EffectiveWorkflow
  retirements: readonly PendingRetirement[]
}>

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
 * Collects what one rebuild replaced. Local to the call that fills it: what leaves is a readonly
 * list the caller folds into the state.
 */
type Replaced = PendingRetirement[]

/**
 * Records an instance a rebuild replaced, so it is released once the last live holder lets go.
 * An instance that never existed has no holder to wait for.
 */
const noteReplaced = (
  replaced: Replaced,
  kind: PendingRetirement['kind'],
  instance: unknown,
  retire: Effect.Effect<void>,
): Effect.Effect<void> =>
  instance === null
    ? retire
    : Effect.sync(() => {
        replaced.push({ kind, instance, retire })
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
  replaced: Replaced,
  input: Input,
): Effect.Effect<Value, BuildError> =>
  cell.get.pipe(
    Effect.flatMap((previous) =>
      cell.rebuild(input).pipe(
        Effect.tap((rebuilt) => noteReplaced(replaced, kind, previous, rebuilt.retirePrevious)),
        Effect.map((rebuilt) => rebuilt.value),
      ),
    ),
  )

const rebuildCodeReview = (
  ports: RuntimePorts,
  replaced: Replaced,
  workflow: Workflow,
): Effect.Effect<CodeReviewPort | null, WorkflowError> =>
  Option.match(ports.codeReviewCell, {
    onNone: () => Effect.succeed<CodeReviewPort | null>(null),
    onSome: (cell) =>
      rebuildCell(cell, 'codeReview', replaced, workflow.tracker).pipe(
        Effect.mapError(portConfigurationError),
        Effect.flatMap((port) => requireCapability(workflow, port)),
      ),
  })

/**
 * Builds every rebuildable port from a workflow the loader has just returned — at startup, and
 * again whenever a reload changes the file. All three are replaced together: a reload can move the
 * workspace root or change a hook as readily as it can change the tracker provider.
 */
export const rebuildEffectiveWorkflow = (
  ports: RuntimePorts,
  workflow: Workflow,
): Effect.Effect<RebuiltWorkflow, WorkflowError> =>
  Effect.gen(function* () {
    const replaced: Replaced = []
    const tracker = yield* rebuildCell(
      ports.trackerCell,
      'tracker',
      replaced,
      workflow.tracker,
    ).pipe(Effect.mapError(portConfigurationError))
    const codeReview = yield* rebuildCodeReview(ports, replaced, workflow)
    const workspaces = yield* rebuildCell(
      ports.workspaceCell,
      'workspaces',
      replaced,
      portsConfiguration(workflow).workspaces,
    )
    return {
      value: { workflow, tracker, codeReview, workspaces, loadedAt: new Date() },
      retirements: replaced,
    }
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
        const replaced: Replaced = []
        const tracker = yield* rebuildCell(
          context.ports.trackerCell,
          'tracker',
          replaced,
          validated,
        ).pipe(Effect.mapError(portConfigurationError))
        const codeReview = yield* rebuildCodeReview(context.ports, replaced, workflow)
        yield* Ref.update(context.state, (current) =>
          Transitions.holdRetirements(current, replaced),
        )
        return { ...effective, workflow, tracker, codeReview }
      })
    }),
  )

const heldInstances = (
  state: RuntimeState,
  select: (execution: ExecutionSnapshot) => unknown,
): readonly unknown[] => [
  ...[...state.running.values()].map((entry) => select(entry.execution)),
  ...[...state.handoffs.values()].map((entry) => select(entry.execution)),
]

/**
 * Whether a run that once used this instance is still going. Adoption changes what the *next* call
 * reaches, not what a call already awaiting a response is using, so an instance a live run has used
 * stays held until that run ends — the reference alone cannot say whether a request is in flight
 * against it, and a host tool leaves Effect for a promise that no scope tracks.
 *
 * Only a run needs this. Everything a handoff calls its ports from runs on the event loop, which is
 * the fiber that drains, so no handoff call can be in flight across a drain.
 */
const supersededByLiveRun = (state: RuntimeState, instance: unknown): boolean =>
  [...state.supersededPorts.values()].some((ports) => ports.includes(instance))

const stillHeld = (state: RuntimeState, retirement: PendingRetirement): boolean => {
  if (supersededByLiveRun(state, retirement.instance)) {
    return true
  }
  switch (retirement.kind) {
    case 'tracker': {
      return (
        state.lastKnownGood.tracker === retirement.instance ||
        heldInstances(state, (execution) => execution.tracker).includes(retirement.instance)
      )
    }
    case 'codeReview': {
      return (
        state.lastKnownGood.codeReview === retirement.instance ||
        heldInstances(state, (execution) => execution.codeReview).includes(retirement.instance)
      )
    }
    case 'workspaces': {
      return (
        state.lastKnownGood.workspaces === retirement.instance ||
        heldInstances(state, (execution) => execution.workspaces).includes(retirement.instance)
      )
    }
  }
}

/**
 * Releases every replaced instance that no live work still holds — neither as the instance a run is
 * using now, nor as one it used before an adoption moved it on. The rest wait for a later pass, and
 * anything never retired is released when the cell's scope closes.
 */
export const drainRetirements = (context: OrchestratorContext): Effect.Effect<void> =>
  Ref.modify(context.state, (current) => {
    const pruned = Transitions.pruneSupersededPorts(current)
    const [pending, drained] = Transitions.takeRetirements(pruned)
    const held = pending.filter((retirement) => stillHeld(drained, retirement))
    return [
      pending.filter((retirement) => !held.includes(retirement)),
      Transitions.holdRetirements(drained, held),
    ] as const
  }).pipe(
    Effect.flatMap((releasable) =>
      Effect.forEach(releasable, (retirement) => retirement.retire, { discard: true }),
    ),
  )

/**
 * Puts a rebuilt workflow in force: it becomes the last known good, and everything already in
 * flight moves onto its ports. The two belong together — a workflow installed without adoption
 * would leave live work calling instances the orchestrator has stopped tracking.
 */
export const installEffectiveWorkflow = (
  context: OrchestratorContext,
  previous: EffectiveWorkflow,
  next: EffectiveWorkflow,
): Effect.Effect<void> =>
  Ref.update(context.state, (current) => Transitions.adoptWorkflow(current, next)).pipe(
    Effect.zipRight(adoptPorts(context, previous, next)),
  )

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
  Ref.modify(context.state, (current) => {
    const adopted = Transitions.adoptExecutions(current, previous, next)
    return [adopted.running, adopted] as const
  }).pipe(
    // Each run's own cell is written from the entry the transition produced, so what a host tool
    // reads and what the state holds cannot drift apart.
    Effect.flatMap((running) =>
      Effect.sync(() => {
        for (const entry of running.values()) {
          MutableRef.set(entry.sessionPorts, {
            tracker: entry.execution.tracker,
            codeReview: entry.execution.codeReview,
          })
        }
      }),
    ),
    Effect.zipRight(drainRetirements(context)),
  )
