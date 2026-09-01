import { Effect } from 'effect'

import type { JsonObject } from '@sloppenheimer/core/domain/domain.js'
import type { HostToolResult, HostToolSession } from '@sloppenheimer/core/domain/host-tools.js'
import { unsupportedHostTool } from '@sloppenheimer/core/domain/host-tools.js'
import { hostToolCallFrom } from './protocol.js'

/**
 * What the App Server asks of Sloppenheimer, and how each kind of request is answered.
 *
 * Sloppenheimer is a client with no operator at a keyboard, so every request has a standing answer:
 * approvals are granted, a widened sandbox is withheld, interactive input fails the turn rather
 * than stalling it, and a host tool runs. Recognizing which is which is the whole of this module.
 */

/**
 * A permissions approval answers with a `GrantedPermissionProfile`, not the `decision` value the
 * command execution and file change approvals take, so it needs its own response.
 */
export const isPermissionsApproval = (method: string): boolean =>
  method.endsWith('/permissions/requestApproval')

/**
 * What Sloppenheimer grants when Codex asks to widen its sandbox mid-turn: nothing, answered in the
 * shape the server can decode.
 *
 * The request asks for additional filesystem paths or network access beyond the sandbox the thread
 * was started with. Echoing it back would let the agent negotiate its own containment, which is
 * exactly what verifying the workspace before launch exists to prevent. An operator widens the
 * sandbox by declaring `codex.turn_sandbox_policy`, where the decision is reviewable, so the turn
 * proceeds here under the sandbox it already has rather than one it asked for.
 *
 * `scope` is the schema's own default; an empty profile makes it immaterial, but stating the
 * narrower of the two values keeps the grant unambiguous.
 */
export const withheldPermissionsGrant: JsonObject = { permissions: {}, scope: 'turn' }

export const isApprovalRequest = (method: string): boolean =>
  /requestApproval$/u.test(method) && !isPermissionsApproval(method)
export const isUserInputRequest = (method: string): boolean => /requestUserInput$/u.test(method)

/**
 * Runs one host tool request and reports what it answered.
 *
 * Every way of not producing an answer is itself an answer: a request that named no tool, a session
 * with no host tools bound, and an execution that threw all report a structured failure, because a
 * request the agent is waiting on must never simply go unanswered.
 */
export const runHostTool = (
  message: JsonObject,
  hostTools: HostToolSession | null,
): Effect.Effect<Readonly<{ tool: string | null; result: HostToolResult }>> =>
  Effect.gen(function* () {
    const { tool, arguments: argumentsValue } = hostToolCallFrom(message)
    if (tool === null || argumentsValue === undefined) {
      return {
        tool,
        result: {
          success: false,
          error: {
            code: 'invalid_arguments',
            message: 'Host tool request is missing tool or arguments',
            retryable: false,
          },
        },
      }
    }
    if (hostTools === null) {
      return { tool, result: unsupportedHostTool(tool) }
    }
    const result = yield* Effect.tryPromise({
      try: async () => await hostTools.execute(tool, argumentsValue, hostTools.context),
      catch: (): HostToolResult => ({
        success: false,
        error: {
          code: 'transport_error',
          message: 'Host tool execution failed unexpectedly',
          retryable: true,
        },
      }),
    }).pipe(Effect.catchAll(Effect.succeed))
    return { tool, result }
  })
