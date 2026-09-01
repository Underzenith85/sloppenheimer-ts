/**
 * The actor-owned record every observation is folded into, and the two operations that do not fold
 * one: opening a record for a newly dispatched issue, and restating the issue fields the tracker
 * can change under it.
 *
 * The folds themselves live beside this module — the shared ones in `folding.ts`, the recorders in
 * `agent-event.ts` and `lifecycle.ts` — so the type and its constructor stay readable as the shape
 * they all answer with.
 */

import type { IssueId, IssueIdentifier } from '../domain/domain.js'
import type { QualityPhase, RateLimitWindow, TokenCounts, ToolState } from './events.js'
import type {
  AgentAttemptSummary,
  AgentErrorSummary,
  AgentHandoffDetail,
  AgentPhase,
  AgentSessionSummary,
  AgentTimelineEvent,
} from './snapshot.js'

type ChangedPath = Readonly<{ addedLines: number; deletedLines: number; lastActivityAt: Date }>

/**
 * Actor-owned telemetry for one issue, as an immutable value. Every recorder folds one observation
 * into a new record instead of editing this one, so the actor can publish the record it holds
 * without copying it: a consumer that was handed an earlier value keeps exactly the reading it was
 * given, and no later update can reach it.
 *
 * The arrays and summaries a record adopts are frozen as they are built, which is what lets
 * `buildAgentDetail` share them rather than clone them.
 */
export type AgentDetailRecord = Readonly<{
  issueId: IssueId
  identifier: IssueIdentifier
  title: string
  url: string | null
  startedAt: Date
  attempt: number
  sequence: number
  /**
   * Attempts started beyond the first. Counted rather than derived from the retained attempt
   * summaries, which are bounded: a long-running failing issue would otherwise report a retry total
   * frozen at the retention limit while its attempt number kept climbing.
   */
  retries: number
  events: readonly AgentTimelineEvent[]
  dropped: number
  phase: AgentPhase
  phaseSince: Date
  operation: string | null
  lastActivityAt: Date | null
  threadId: string | null
  turnId: string | null
  sessionId: string | null
  processId: number | null
  turnCount: number
  tokens: TokenCounts
  rateLimits: readonly RateLimitWindow[]
  sessions: readonly AgentSessionSummary[]
  attempts: readonly AgentAttemptSummary[]
  errors: readonly AgentErrorSummary[]
  changedPaths: ReadonlyMap<string, ChangedPath>
  pathsTruncated: boolean
  addedLines: number
  deletedLines: number
  lastFileActivityAt: Date | null
  qualityPhase: QualityPhase | null
  qualityCommandState: ToolState | null
  workspacePathKey: string
  handoff: AgentHandoffDetail
}>

export type AgentDetailInput = Readonly<{
  issueId: IssueId
  identifier: IssueIdentifier
  title: string
  url: string | null
  attempt: number | null
  startedAt: Date
  workspacePathKey: string
  expectedBranch: string | null
  dispatchLabels: readonly string[]
}>

export const createAgentDetailRecord = (input: AgentDetailInput): AgentDetailRecord => ({
  issueId: input.issueId,
  identifier: input.identifier,
  title: input.title,
  url: input.url,
  startedAt: input.startedAt,
  attempt: input.attempt ?? 0,
  sequence: 0,
  retries: 0,
  events: Object.freeze([]),
  dropped: 0,
  phase: 'starting',
  phaseSince: input.startedAt,
  operation: null,
  lastActivityAt: null,
  threadId: null,
  turnId: null,
  sessionId: null,
  processId: null,
  turnCount: 0,
  tokens: Object.freeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  rateLimits: Object.freeze([]),
  sessions: Object.freeze([]),
  attempts: Object.freeze([
    Object.freeze({
      attempt: input.attempt ?? 0,
      startedAt: input.startedAt.toISOString(),
      endedAt: null,
      outcome: 'running' as const,
      reason: null,
      firstSequence: 1,
      lastSequence: 0,
    }),
  ]),
  errors: Object.freeze([]),
  changedPaths: new Map(),
  pathsTruncated: false,
  addedLines: 0,
  deletedLines: 0,
  lastFileActivityAt: null,
  qualityPhase: null,
  qualityCommandState: null,
  workspacePathKey: input.workspacePathKey,
  handoff: Object.freeze({
    expectedBranch: input.expectedBranch,
    remoteBranch: Object.freeze({ status: 'pending' as const, name: null }),
    pullRequest: Object.freeze({
      status: 'pending' as const,
      number: null,
      url: null,
      state: null,
    }),
    dispatchLabels: Object.freeze({
      labels: Object.freeze([...input.dispatchLabels]),
      status: 'not_performed' as const,
      // Stated rather than implied: the GitHub adapter hands work off by opening a pull request and
      // leaves the dispatch label in place, so an operator is not left waiting for a removal that
      // is never going to be observed.
      reason: 'The tracker adapter does not remove dispatch labels at handoff',
    }),
    outcome: 'in_progress' as const,
    reason: null,
  }),
})

/**
 * Restates the issue fields that the tracker can change between attempts. The rest of the record —
 * the timeline, the attempt history, the sequence — is what makes it worth keeping across them.
 */
export const recordIssueRefreshed = (
  record: AgentDetailRecord,
  issue: Readonly<{ title: string; url: string | null }>,
): AgentDetailRecord => ({ ...record, title: issue.title, url: issue.url })
