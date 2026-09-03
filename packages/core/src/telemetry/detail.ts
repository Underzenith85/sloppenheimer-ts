/**
 * The published snapshot, built from the record on demand.
 *
 * A record is what the actor holds; a snapshot is what a consumer is handed. Everything that
 * depends on the moment of the read — how long the agent has been idle, whether that idleness has
 * crossed the stall deadline — is computed here rather than recorded, so a record that no event has
 * touched still reports a truthful reading each time it is published.
 */

import { boundRedacted } from '../support/redaction.js'
import type { AgentDetailRecord } from './record.js'
import { timelineEventLimit } from './snapshot.js'
import type { AgentDetailSnapshot, AgentDetailStatus, AgentPhase } from './snapshot.js'

export type AgentDetailContext = Readonly<{
  self: string
  now: Date
  status: AgentDetailStatus
  stallTimeoutMs: number
  workerHost: string
  /** Whether the execution behind this agent has a code-review port to hand its work off to. */
  handoffEnabled: boolean
  branch: string | null
  retry: Readonly<{ attempt: number; dueAt: Date; reason: string | null }> | null
}>

/**
 * Builds the exact, immutable snapshot published to operator consumers.
 *
 * Only the objects assembled here are frozen. Everything taken straight from the record — the
 * timeline, the attempt and session histories, the retained errors, the rate-limit windows, the
 * token counts, and the handoff detail — was frozen as the record adopted it and is shared rather
 * than copied: the record is a value that no recorder edits, so there is nothing for a consumer to
 * observe changing underneath it and nothing reachable to write through.
 */
export const buildAgentDetail = (
  record: AgentDetailRecord,
  context: AgentDetailContext,
): AgentDetailSnapshot => {
  const now = context.now.getTime()
  // Silence is the agent's only once there is an agent: the countdown runs from its last event,
  // or from its launch until it has reported anything, and not at all while the host is still
  // preparing the run — the same rule the stall sweep applies to the run itself.
  const activeAt = record.lastActivityAt ?? record.agentStartedAt
  const idleMs = Math.max(now - (activeAt ?? record.startedAt).getTime(), 0)
  // An agent that has been cancelled, is waiting to retry, is publishing, or is handing off is not
  // working, so silence from it is expected rather than evidence of a stall.
  const settledPhase =
    record.phase === 'cancelled' ||
    record.phase === 'retrying' ||
    record.phase === 'publishing' ||
    record.phase === 'handing_off'
  const stallDeadline =
    activeAt !== null && context.stallTimeoutMs > 0 && context.status === 'running' && !settledPhase
      ? new Date(activeAt.getTime() + context.stallTimeoutMs)
      : null
  const stalled = stallDeadline !== null && stallDeadline.getTime() <= now
  const phase: AgentPhase = stalled ? 'stalled' : record.phase
  return Object.freeze({
    version: 'v1',
    self: context.self,
    generatedAt: context.now.toISOString(),
    issueId: record.issueId,
    identifier: record.identifier,
    title: record.title,
    url: record.url,
    status: context.status,
    handoffEnabled: context.handoffEnabled,
    identity: Object.freeze({
      threadId: record.threadId,
      turnId: record.turnId,
      sessionId: record.sessionId,
      processId: record.processId,
      turnNumber: record.turnCount,
      workerHost: context.workerHost,
    }),
    attempt: Object.freeze({
      current: record.attempt,
      retries: record.retries,
      attempts: record.attempts,
      sessions: record.sessions,
    }),
    phase: Object.freeze({
      phase,
      operation: record.operation,
      since: (stalled && stallDeadline !== null ? stallDeadline : record.phaseSince).toISOString(),
    }),
    activity: Object.freeze({
      startedAt: record.startedAt.toISOString(),
      lastActivityAt: record.lastActivityAt?.toISOString() ?? null,
      elapsedMs: Math.max(now - record.startedAt.getTime(), 0),
      idleMs,
      stallTimeoutMs: context.stallTimeoutMs,
      stallDeadline: stallDeadline?.toISOString() ?? null,
      stallCountdownMs: stallDeadline === null ? null : Math.max(stallDeadline.getTime() - now, 0),
      stalled,
    }),
    usage: record.tokens,
    rateLimits: record.rateLimits,
    workspace: Object.freeze({
      pathKey: record.workspacePathKey,
      branch: context.branch ?? record.handoff.expectedBranch,
      dirtyFileCount: record.changedPaths.size,
      addedLines: record.addedLines,
      deletedLines: record.deletedLines,
      lastFileActivityAt: record.lastFileActivityAt?.toISOString() ?? null,
      qualityPhase: record.qualityPhase,
      qualityCommandState: record.qualityCommandState,
      pathsTruncated: record.pathsTruncated,
    }),
    handoff: record.handoff,
    retry:
      context.retry === null
        ? null
        : Object.freeze({
            attempt: context.retry.attempt,
            dueAt: context.retry.dueAt.toISOString(),
            reason: context.retry.reason === null ? null : boundRedacted(context.retry.reason).text,
          }),
    errors: record.errors,
    timeline: Object.freeze({
      events: record.events,
      retained: record.events.length,
      dropped: record.dropped,
      limit: timelineEventLimit,
    }),
  })
}
