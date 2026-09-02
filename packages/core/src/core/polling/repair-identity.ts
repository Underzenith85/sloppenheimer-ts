import { Effect, Option, Ref } from 'effect'

import type { IssueId } from '../../domain/domain.js'
import { releaseRepair } from '../repair.js'
import type { OrchestratorContext } from '../runtime.js'
import type { HandoffEntry } from '../state.js'
import * as Transitions from '../transitions.js'

/**
 * One handoff write, persisted as it is made.
 *
 * The repair-identity changes the mailbox handlers make stand alone rather than arriving as a
 * batch, so each is durable before the next thing happens — unlike `stageHandoff` in
 * `handoff-reconciliation.ts`, where a whole pass is flushed once at its end.
 */
export const writeHandoff = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry,
): Effect.Effect<void> =>
  Ref.update(context.state, (current) => Transitions.putHandoff(current, id, handoff)).pipe(
    Effect.zipRight(context.persistHandoffs),
  )

/** Ends a repair: whatever identity it was carrying goes with it. */
export const releaseHandoffRepair = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: Option.Option<HandoffEntry>,
): Effect.Effect<void> =>
  Option.match(handoff, {
    onNone: () => Effect.void,
    onSome: (entry) =>
      Option.isNone(entry.repair) ? Effect.void : writeHandoff(context, id, releaseRepair(entry)),
  })
