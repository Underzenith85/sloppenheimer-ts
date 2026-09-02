import { FileSystem } from '@effect/platform'
import { Effect, Option, Ref, Runtime, type Scope } from 'effect'

import { AgentError, type WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import type { AgentLaunch, AgentResult } from '@sloppenheimer/core/ports/agent-runner.js'
import type { VerifiedWorkspace } from '@sloppenheimer/core/domain/workspace-containment.js'
import {
  assertWorkspaceIdentity,
  openVerifiedWorkspace,
} from '@sloppenheimer/adapter-node/workspace-identity.js'
import { CodexConnection } from './connection.js'
import { initialConnectionState } from './connection-state.js'
import { sessionSecretValues } from './session.js'
import { telemetryFrom } from './protocol.js'

/**
 * Launching Codex for one issue: workspace verification, the session's scope, and the turn loop.
 *
 * This module is the adapter's entry point. It also re-exports the session vocabulary the
 * composition root and the conformance suites read a Codex run through.
 */

export { telemetryFrom }
export {
  boundedMessage,
  codexMaxLineBytes,
  codexTurnOutcome,
  composeSessionId,
  isCancelledTurnStatus,
  makeCodexEnvironment,
  sessionSecretValues,
} from './session.js'
export type { AgentEvent } from '@sloppenheimer/core/telemetry.js'
export type { AgentLaunch, AgentResult } from '@sloppenheimer/core/ports/agent-runner.js'

const rejectWorkspaceLaunch = (error: WorkspaceError): AgentError =>
  new AgentError({
    category: 'workspace_rejected',
    message: `refusing to launch Codex: ${error.message}`,
    cause: error,
  })

/**
 * Re-binds the verified workspace's identity.
 *
 * A path string is re-resolved by the kernel at every consumer, so the identity is re-bound at each
 * path-consuming boundary: after the process is created and before every turn. A directory renamed
 * and replaced by a symlink in between is rejected rather than followed.
 *
 * The filesystem is the one bound at launch rather than read from the calling fiber, so a rebind
 * runs the same way from a forked reader as it does from the session's own fiber.
 */
const rebindWorkspace = (
  launch: AgentLaunch,
  verified: VerifiedWorkspace,
  fileSystem: FileSystem.FileSystem,
): Effect.Effect<void, AgentError> =>
  assertWorkspaceIdentity(launch.workspaceRoot, verified).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.mapError(rejectWorkspaceLaunch),
  )

/**
 * Opens a session, and stops it when the scope closes.
 *
 * The session's readers are forked against that same scope, so they belong to the run rather than
 * to the default runtime. The scope closes after the session has stopped, which is where a reader
 * the stop did not already finish is interrupted.
 */
const openConnection = (
  launch: AgentLaunch,
  verified: VerifiedWorkspace,
  runtime: Runtime.Runtime<never>,
  scope: Scope.Scope,
): Effect.Effect<CodexConnection, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.all([
      sessionSecretValues(launch.secretEnvironmentNames),
      Ref.make(initialConnectionState),
      Effect.makeSemaphore(1),
    ]).pipe(
      Effect.map(
        ([knownSecretValues, state, lifecycle]) =>
          new CodexConnection(
            launch.config.command,
            verified.path,
            launch.config,
            launch.secretEnvironmentNames,
            knownSecretValues,
            launch.traceCapture,
            launch.hostTools ?? null,
            launch.onEvent,
            (reader) => Runtime.runFork(runtime)(reader, { scope }),
            state,
            lifecycle,
          ),
      ),
    ),
    (connection) => connection.stop(),
  )

/**
 * Runs turns on an initialized session until the issue stops being routable or the launch's turn
 * budget is spent. The workspace identity is re-bound around every turn.
 */
const runTurns = (
  connection: CodexConnection,
  launch: AgentLaunch,
  verified: VerifiedWorkspace,
  threadId: string,
  rebind: () => Effect.Effect<void, AgentError>,
): Effect.Effect<AgentResult, AgentError> =>
  Effect.gen(function* () {
    let turnId = ''
    let turnCount = 0
    while (turnCount < launch.maxTurns) {
      const turnPrompt =
        turnCount === 0
          ? launch.prompt
          : 'Continue working on the issue. Review prior progress and complete the next necessary step.'
      yield* rebind()
      turnId = yield* connection.startTurn(
        threadId,
        verified.path,
        launch.config,
        turnPrompt,
        turnCount + 1,
      )
      yield* rebind()
      yield* connection.awaitTurn(turnId)
      turnCount += 1
      const refreshed = yield* launch.refreshIssue().pipe(Effect.map(Option.fromNullable))
      if (Option.isNone(refreshed) || !launch.isRoutable(refreshed.value)) {
        break
      }
    }
    return { threadId, turnId, turnCount }
  })

const runVerifiedAgent = (
  launch: AgentLaunch,
  verified: VerifiedWorkspace,
  fileSystem: FileSystem.FileSystem,
): Effect.Effect<AgentResult, AgentError> => {
  const rebind = (): Effect.Effect<void, AgentError> =>
    rebindWorkspace(launch, verified, fileSystem)
  return Effect.scoped(
    Effect.gen(function* () {
      const [runtime, scope] = yield* Effect.all([Effect.runtime<never>(), Effect.scope])
      const connection = yield* openConnection(launch, verified, runtime, scope)
      yield* rebind()
      const threadId = yield* connection.initialize(launch.config, verified.path)
      // Re-bound after the boundary too: a swap during the request window is then detected and the
      // session torn down before any turn runs.
      yield* rebind()
      return yield* runTurns(connection, launch, verified, threadId, rebind)
    }).pipe(
      Effect.catchAllDefect((cause: unknown) =>
        Effect.fail(
          cause instanceof AgentError
            ? cause
            : new AgentError({
                category: 'protocol_error',
                message: `Codex session failed for ${launch.issue.identifier}`,
                cause,
              }),
        ),
      ),
    ),
  )
}

/**
 * Launches Codex for one issue.
 *
 * Workspace containment is verified against the configured root immediately before the process is
 * created, and the verified real path — not the caller-supplied one — becomes the subprocess cwd
 * and the thread/turn `cwd`. Because a path string is re-resolved by the kernel at every consumer,
 * the verified directory's identity is re-bound after the process is created and before every
 * turn, so a stale, forged, or substituted workspace can never be entered.
 */
export const runAgent = (
  launch: AgentLaunch,
): Effect.Effect<AgentResult, AgentError, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    Effect.scoped(
      openVerifiedWorkspace(launch.workspaceRoot, launch.workspace).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.mapError(rejectWorkspaceLaunch),
        Effect.flatMap((verified) => runVerifiedAgent(launch, verified, fileSystem)),
      ),
    ),
  )
