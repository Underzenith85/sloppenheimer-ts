import { Option } from 'effect'

import type { JsonObject } from '@sloppenheimer/core/domain/domain.js'
import { AgentError } from '@sloppenheimer/core/domain/errors.js'
import type { TokenCounts } from '@sloppenheimer/core/telemetry.js'
import type { TurnSettlement } from './connection-state.js'
import { notificationIdentity, telemetryFrom, turnFrom, type ProtocolTurn } from './protocol.js'
import { isCancelledTurnStatus } from './session.js'

/**
 * What one App Server notification says about itself, read before any of it is acted on.
 *
 * Reading is separated from acting because the connection has to claim the turn a terminal
 * notification reports on *before* any side effect of that notification, and cannot know it is
 * terminal until the message has been read.
 */
export type NotificationFacts = Readonly<{
  /** The turn the notification names, if it names one. */
  turn: Option.Option<ProtocolTurn>
  threadId: Option.Option<string>
  /** The turn id the message declared, which the turn it parsed does not necessarily repeat. */
  turnId: Option.Option<string>
  parsedTurnId: Option.Option<string>
  usage: Option.Option<TokenCounts>
  rateLimits: Option.Option<JsonObject>
  isTerminal: boolean
  /**
   * How a terminal notification says the turn ended, and `none` for one that is not terminal. A
   * terminal notification that omits the status still reports one: `turn/failed` failed whatever
   * else it says, and a `turn/completed` without a status is `unreported` rather than complete.
   */
  terminalStatus: Option.Option<string>
}>

export const notificationFacts = (method: string, message: JsonObject): NotificationFacts => {
  const turn = Option.fromNullable(turnFrom(message))
  const carried = notificationIdentity(message)
  const telemetry = telemetryFrom(method, message)
  const isTerminal = method === 'turn/completed' || method === 'turn/failed'
  return {
    turn,
    threadId: Option.fromNullable(carried.threadId),
    turnId: Option.fromNullable(carried.turnId),
    parsedTurnId: Option.map(turn, (current) => current.id),
    usage: Option.fromNullable(telemetry.usage),
    rateLimits: Option.fromNullable(telemetry.rateLimits),
    isTerminal,
    terminalStatus: isTerminal
      ? Option.map(turn, (current) =>
          Option.getOrElse(Option.fromNullable(current.status), () =>
            method === 'turn/failed' ? 'failed' : 'unreported',
          ),
        )
      : Option.none(),
  }
}

/** How a turn that did not complete is reported to whoever is awaiting it. */
export const terminalSettlement = (turnId: string, status: string): TurnSettlement =>
  status === 'completed'
    ? { _tag: 'completed' }
    : {
        _tag: 'failed',
        error: new AgentError({
          category: isCancelledTurnStatus(status) ? 'turn_cancelled' : 'turn_failed',
          message: `turn ${turnId} finished with status ${status}`,
        }),
      }
