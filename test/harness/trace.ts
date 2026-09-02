import { Effect, Stream } from 'effect'

import { workflowDefaults } from '@sloppenheimer/core/config/workflow.js'
import type {
  TraceBody,
  TraceCategory,
  TraceEvent,
  TraceOutcome,
} from '@sloppenheimer/core/domain/trace.js'
import type { TracePage, TraceQuery } from '@sloppenheimer/core'

/**
 * Trace fixtures for the console and API tests: one record, and the two backend fields every
 * `OperatorBackend` fake has to supply.
 *
 * The paging is the real thing rather than a stub that ignores its query — `after` and `limit` are
 * what the route contract is about, so a fake that answered the same page whatever it was asked
 * would let a broken cursor pass.
 */

export const traceEvent = (overrides: Partial<TraceEvent> = {}): TraceEvent => ({
  version: 1,
  sequence: 1,
  recordedAt: '2026-09-01T10:00:00.000Z',
  issueId: '18',
  identifier: 'example/sloppenheimer#18',
  runId: 1,
  attempt: 0,
  threadId: 'thread-1',
  turnId: 'turn-1',
  sessionId: 'thread-1-turn-1',
  turnCount: 1,
  event: 'item/completed',
  category: 'message' satisfies TraceCategory,
  outcome: 'succeeded' satisfies TraceOutcome,
  body: { kind: 'message', role: 'assistant', text: 'done' } satisfies TraceBody,
  redacted: false,
  truncations: [],
  ...overrides,
})

export const tracePage = (
  events: readonly TraceEvent[],
  overrides: Partial<TracePage> = {},
): TracePage => ({
  enabled: true,
  identifier: 'example/sloppenheimer#18',
  events,
  nextAfter: events.at(-1)?.sequence ?? 0,
  hasMore: false,
  malformedRecords: 0,
  limits: workflowDefaults.trace.limits,
  evictions: [],
  evictionsTotal: 0,
  ...overrides,
})

/** The two trace fields of an `OperatorBackend`, serving a fixed history and no live records. */
export const traceBackendFields = (
  events: readonly TraceEvent[] = [],
  overrides: Partial<TracePage> = {},
): Readonly<{
  agentTrace: (identifier: string, query: TraceQuery) => Effect.Effect<TracePage>
  agentTraceStream: (identifier: string) => Stream.Stream<TraceEvent>
}> => ({
  agentTrace: (identifier, query) => {
    const matched = events
      .filter((event) => event.sequence > query.after)
      .filter((event) => query.categories === null || query.categories.includes(event.category))
      .filter((event) => query.outcomes === null || query.outcomes.includes(event.outcome))
    const page = matched.slice(0, query.limit)
    return Effect.succeed(
      tracePage(page, {
        identifier,
        nextAfter: page.at(-1)?.sequence ?? query.after,
        hasMore: matched.length > page.length,
        ...overrides,
      }),
    )
  },
  agentTraceStream: () => Stream.empty,
})
