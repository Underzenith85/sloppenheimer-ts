import { Deferred, Effect, Exit, MutableRef, Queue, Ref } from 'effect'

import { AgentError, type WorkspaceError } from '../domain/errors.js'
import type { Issue, Workspace } from '../domain/domain.js'
import type { AgentEvent } from '../telemetry.js'
import type { SessionLaunch } from './dispatch.js'
import { issueIsActive, issueIsRoutable } from './policy.js'
import { superviseAgent } from './supervise-agent.js'
import * as Transitions from './transitions.js'

const isLifecycleEvent = (update: AgentEvent): boolean => update.lifecycle !== null

/** Re-reads the issue through whichever tracker instance the run holds at the moment it asks. */
const refreshIssueThrough =
  (launch: SessionLaunch): (() => Effect.Effect<Issue | null, AgentError>) =>
  () =>
    MutableRef.get(launch.sessionPorts)
      .tracker.fetchIssuesByIds([launch.issue.id])
      .pipe(
        Effect.map((issues) => issues[0] ?? null),
        Effect.mapError(
          (error) =>
            new AgentError({
              category: 'protocol_error',
              message: `issue refresh failed: ${error.message}`,
              cause: error,
            }),
        ),
      )

/** One agent session, inside the workspace hooks that bracket it. */
export const runSession = (
  launch: SessionLaunch,
  workspace: Workspace,
): Effect.Effect<void, AgentError | WorkspaceError> => {
  const { context, issue, execution } = launch
  return execution.workspaces.beforeRun(workspace).pipe(
    Effect.zipRight(
      Effect.gen(function* () {
        const applied = yield* Deferred.make<boolean>()
        yield* Queue.offer(context.mailbox, {
          _tag: 'AgentStarted',
          issueId: issue.id,
          runId: launch.runId,
          applied,
        })
        if (!(yield* Deferred.await(applied))) {
          return yield* Effect.interrupt
        }
      }),
    ),
    Effect.zipRight(
      superviseAgent(context.ports.agentRunner, {
        issue,
        workspace,
        workspaceRoot: execution.workspaceRoot,
        config: execution.agentRunner,
        prompt: execution.prompt,
        maxTurns: execution.maxTurns,
        secretEnvironmentNames: execution.secretEnvironmentNames,
        hostTools: launch.hostTools,
        refreshIssue: refreshIssueThrough(launch),
        isRoutable: (refreshed) =>
          issueIsActive(refreshed, execution) && issueIsRoutable(refreshed, execution),
        // The runner reports progress from a plain callback. Recording what the update owes
        // the run and enqueueing it are one step, so an exit cannot overtake a report the
        // callback has already made.
        onEvent: (update) => {
          context.runFromCallback(
            Ref.update(context.state, (current) => {
              if (current.running.get(issue.id)?.runId !== launch.runId) {
                return current
              }
              let next = current
              if (update.usage !== null) {
                next = Transitions.recordPendingUsage(next, issue.id, update.usage)
              }
              if (update.rateLimits !== null) {
                next = Transitions.recordPendingRateLimits(next, update.rateLimits)
              }
              if (isLifecycleEvent(update)) {
                next = Transitions.queuePendingLifecycle(next, issue.id, update)
              }
              return next
            }).pipe(
              Effect.zipRight(
                Queue.offer(context.mailbox, {
                  _tag: 'AgentUpdate',
                  issueId: issue.id,
                  runId: launch.runId,
                  update,
                }),
              ),
              Effect.asVoid,
            ),
          )
        },
      }),
    ),
    Effect.onExit((exit) =>
      Exit.isInterrupted(exit)
        ? Effect.void
        : Effect.interruptible(execution.workspaces.afterRun(workspace)),
    ),
    Effect.asVoid,
  )
}
