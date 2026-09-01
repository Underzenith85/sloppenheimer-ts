import { Effect } from 'effect'

import type { Issue } from '../../domain/domain.js'
import { logWarning } from '../../support/logging.js'
import { logContext, stateIsIn } from '../policy.js'
import type { EffectiveWorkflow } from '../state.js'

/**
 * Removes the workspace of every issue that reached a terminal state while the orchestrator was
 * down. It runs before any state exists, and answers only to the tracker and the filesystem.
 */
export const cleanupTerminalWorkspaces = (effective: EffectiveWorkflow): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const issue of yield* terminalIssues(effective)) {
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
      const current = yield* stillTerminal(effective, issue)
      if (current === null) {
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

/** Every issue the tracker reports in a terminal state, deduplicated across the states. */
const terminalIssues = (effective: EffectiveWorkflow): Effect.Effect<readonly Issue[]> =>
  Effect.forEach(
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
  ).pipe(
    Effect.map((groups) => [...new Map(groups.flat().map((issue) => [issue.id, issue])).values()]),
  )

/**
 * Rechecks an issue immediately before its workspace is removed, and answers with the fresh record
 * when it is still terminal. A recheck that fails, or that finds the issue reopened, answers
 * `null` and the workspace is left alone.
 */
const stillTerminal = (effective: EffectiveWorkflow, issue: Issue): Effect.Effect<Issue | null> =>
  effective.tracker.fetchIssuesByIds([issue.id], { hydrateDependencies: false }).pipe(
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
    Effect.map((refreshed) => {
      const current = refreshed?.find((candidate) => candidate.id === issue.id)
      return current === undefined ||
        !stateIsIn(current.state, effective.workflow.config.tracker.terminalStates)
        ? null
        : current
    }),
  )
