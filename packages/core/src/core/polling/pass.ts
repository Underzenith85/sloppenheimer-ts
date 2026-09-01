import { Effect, Ref, type Scope } from 'effect'

import type { Issue } from '../../domain/domain.js'
import type { Workflow } from '../../config/workflow.js'
import { currentInstant } from '../../support/clock.js'
import { logError, logInfo } from '../../support/logging.js'
import { asSettled } from '../../support/settled.js'
import { examineWorkspaces, sweepRetainedDeliveries } from '../delivery-recovery.js'
import { dispatch } from '../dispatch.js'
import { reconcileHandoffs } from '../handoff-reconciliation.js'
import { dispatchAdmission, sortIssues } from '../policy.js'
import type { OrchestratorContext } from '../runtime.js'
import type { RefreshOperation } from '../state.js'
import * as Transitions from '../transitions.js'
import {
  drainRetirements,
  installEffectiveWorkflow,
  revalidateCredentials,
} from '../workflow-reload.js'

/**
 * Files the reason a validation stage refused, so the console can say why the workflow in force is
 * older than the one on disk. Answers `true`, which every caller folds into the pass's "dispatch is
 * not safe" flag.
 */
const refuseWorkflow = (
  context: OrchestratorContext,
  message: string,
  stage: string,
  effectiveFingerprint: string,
  refusal: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const observedAt = yield* currentInstant
    yield* Ref.update(context.state, (current) =>
      Transitions.setWorkflowReloadError(current, { message, observedAt }),
    )
    yield* logError(refusal, {
      action: 'workflow_validation',
      outcome: 'failed',
      stage,
      error: message,
      effective_fingerprint: effectiveFingerprint,
    })
    return true
  })

/**
 * Re-reads the tracker credential from the environment, adopting a rebuilt port when it changed.
 * Answers whether validation failed, in which case the last known good workflow stays in force.
 */
const refreshCredentials = (context: OrchestratorContext): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const opening = yield* Ref.get(context.state)
    const revalidated = yield* revalidateCredentials(context, opening.lastKnownGood).pipe(asSettled)
    if (revalidated._tag === 'Failed') {
      return yield* refuseWorkflow(
        context,
        revalidated.error.message,
        'credential_revalidation',
        opening.lastKnownGood.workflow.fingerprint,
        'tracker credential validation failed; retaining last known good',
      )
    }
    if (revalidated.value !== opening.lastKnownGood) {
      yield* installEffectiveWorkflow(context, opening.lastKnownGood, revalidated.value)
      yield* logInfo('tracker credential refreshed from the environment', {
        tracker_kind: revalidated.value.workflow.tracker.kind,
        secret_environment_names:
          revalidated.value.workflow.tracker.secretEnvironmentNames.join(', '),
      })
    }
    return false
  })

/**
 * Re-reads the workflow definition off disk and configures its ports when the fingerprint moved.
 * Answers whether either step failed, in which case the last known good workflow stays in force.
 */
const reloadWorkflow = (context: OrchestratorContext): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const reloading = yield* Ref.get(context.state)
    const reloaded = yield* context.ports.workflowLoader.load(context.selectedWorkflowPath).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          refuseWorkflow(
            context,
            error.message,
            'reload',
            reloading.lastKnownGood.workflow.fingerprint,
            'workflow validation failed; retaining last known good',
          ).pipe(Effect.as(null)),
        onSuccess: (loaded) => Effect.succeed<Workflow | null>(loaded),
      }),
    )
    if (reloaded === null) {
      return true
    }
    const before = yield* Ref.get(context.state)
    if (reloaded.fingerprint === before.lastKnownGood.workflow.fingerprint) {
      return false
    }
    const configured = yield* context.makeEffectiveWorkflow(reloaded).pipe(asSettled)
    if (configured._tag === 'Failed') {
      return yield* refuseWorkflow(
        context,
        configured.error.message,
        'port_configuration',
        before.lastKnownGood.workflow.fingerprint,
        'workflow port configuration failed; retaining last known good',
      )
    }
    yield* installEffectiveWorkflow(context, before.lastKnownGood, configured.value)
    yield* logInfo('workflow reloaded', {
      path: reloaded.path,
      fingerprint: reloaded.fingerprint,
    })
    return false
  })

/** Dispatches every candidate the workflow in force still has room for, in priority order. */
const dispatchCandidates = (
  context: OrchestratorContext,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const dispatching = yield* Ref.get(context.state)
    const effective = dispatching.lastKnownGood
    const requiredLabels = effective.workflow.config.tracker.requiredLabels
    const candidates = yield* effective.tracker
      .fetchIssuesByStates(
        effective.workflow.config.tracker.activeStates,
        // No required labels means every candidate is in scope, so hydrate every candidate's
        // blockers. An empty list is reserved for callers that want no hydration at all.
        requiredLabels.length === 0 ? null : requiredLabels,
      )
      .pipe(
        Effect.catchAll((error) =>
          logError('candidate fetch failed', { error: error.message }).pipe(
            Effect.as<readonly Issue[]>([]),
          ),
        ),
      )
    // Every candidate this pass could dispatch is looked at first, which is what covers an issue
    // that became active after the startup sweep: it arrives with whatever its workspace holds.
    yield* examineWorkspaces(context, candidates)
    for (const issue of sortIssues(candidates)) {
      // Read afresh: a dispatch earlier in this pass may have taken the slot this one wanted.
      const current = yield* Ref.get(context.state)
      if (dispatchAdmission(current, issue, effective.workflow)._tag !== 'Admit') {
        continue
      }
      yield* dispatch(context, issue, null)
    }
  })

/**
 * One reconciliation pass, answering with the stages it reached. A caller that asked for this pass
 * — a refresh over the HTTP API — is told what it actually got: a pass whose validation failed
 * stops before dispatch, and saying otherwise would be reporting an intention rather than an event.
 */
export const poll = (
  context: OrchestratorContext,
): Effect.Effect<readonly RefreshOperation[], never, Scope.Scope> =>
  Effect.gen(function* () {
    const performed: RefreshOperation[] = []
    // A worker that ended since the last pass may have been the last holder of a replaced instance.
    yield* drainRetirements(context)
    let dispatchValidationFailed = yield* refreshCredentials(context)
    performed.push('credential_revalidation')
    yield* context.hydrateRestoredHandoffs
    yield* context.recoverMissingHandoffs
    performed.push('handoff_recovery')
    // Before anything can put an agent on an issue: a workspace holding work a previous process
    // never published is published from here, rather than being handed to a repair that would
    // spend a turn and one of the repair budget rediscovering it. A workspace it could not read is
    // recorded, and dispatch refuses that issue until a later pass manages to look.
    const sweep = yield* sweepRetainedDeliveries(context)
    if (sweep !== 'skipped') {
      performed.push('delivery_recovery')
    }
    dispatchValidationFailed = (yield* reloadWorkflow(context)) || dispatchValidationFailed
    performed.push('workflow_reload')
    // A sweep that could not look at anything refuses repair dispatch as well: a repair is an agent
    // put into a workspace, and this pass cannot say which workspaces hold work nobody published.
    yield* reconcileHandoffs(context, !dispatchValidationFailed && sweep !== 'failed')
    performed.push('handoff_reconciliation')
    yield* context.reconcile(!dispatchValidationFailed)
    performed.push('issue_reconciliation')
    if (dispatchValidationFailed) {
      return performed
    }
    yield* Ref.update(context.state, (current) => Transitions.setWorkflowReloadError(current, null))
    yield* dispatchCandidates(context)
    performed.push('dispatch')
    return performed
  })
