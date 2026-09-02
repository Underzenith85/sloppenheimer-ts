import type { FileSystem } from '@effect/platform'
import { Effect } from 'effect'

import { issueIdentifier } from '../../domain/domain.js'
import type { TraceStoreError } from '../../domain/errors.js'
import { workspaceKey } from '../../domain/workspace-containment.js'
import type { TraceEvent } from '../../domain/trace.js'
import { emptyEvictionLog, loadEvictions } from '../trace-retention.js'
import { evictionPath, listSegments, readSegment, traceRoot } from '../trace-store.js'
import type { TracePage, TraceQuery, TraceStore } from './trace-types.js'

/**
 * Reading a durable trace back: one page of one issue's history, and the metadata that explains
 * what the page is missing.
 *
 * Paging is by sequence rather than by offset. Sequence is monotonic per issue and assigned at
 * append, so `after` names a record rather than a position, and a page taken while the run is still
 * writing cannot skip or repeat an event because a new segment opened between two requests.
 *
 * Every page carries the limits in force, the recorded evictions, and how many lines this read
 * could not decode. An operator looking at a gap is entitled to be told whether it is retention, a
 * ceiling, or a torn write — none of the three should have to be inferred from an absence.
 *
 * A read that fails answers with an empty page rather than an error. The console polls this while
 * an agent runs, and a transient filesystem failure is not worth turning into an operator-visible
 * outage of the console itself; the failure is logged where it happened.
 */

/** The most events one request may take, whatever it asked for. */
export const tracePageLimit = 200

const matches = (event: TraceEvent, query: TraceQuery): boolean => {
  if (query.categories !== null && !query.categories.includes(event.category)) {
    return false
  }
  if (query.outcomes !== null && !query.outcomes.includes(event.outcome)) {
    return false
  }
  if (query.attempt !== null && event.attempt !== query.attempt) {
    return false
  }
  return query.turnId === null || event.turnId === query.turnId
}

type Collected = Readonly<{
  events: readonly TraceEvent[]
  malformed: number
  hasMore: boolean
}>

const collect = (
  root: string,
  identifierKey: string,
  query: TraceQuery,
): Effect.Effect<Collected, TraceStoreError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const limit = Math.min(Math.max(query.limit, 1), tracePageLimit)
    const segments = (yield* listSegments(root)).filter(
      (segment) => segment.identifierKey === identifierKey,
    )
    const events: TraceEvent[] = []
    let malformed = 0
    let hasMore = false
    for (const segment of segments) {
      const contents = yield* readSegment(segment.path)
      malformed += contents.malformed
      for (const event of contents.events) {
        if (event.sequence <= query.after || !matches(event, query)) {
          continue
        }
        if (events.length === limit) {
          // The walk continues past the limit so the malformed count covers the whole history
          // rather than only the part that fit on this page.
          hasMore = true
          continue
        }
        events.push(event)
      }
    }
    return { events, malformed, hasMore }
  })

const emptyPage = (store: TraceStore, identifier: string, after: number): TracePage => ({
  enabled: store.enabled,
  identifier,
  events: [],
  nextAfter: after,
  hasMore: false,
  malformedRecords: 0,
  limits: store.limits,
  evictions: [],
  evictionsTotal: 0,
})

export const readTracePage = (
  store: TraceStore,
  workspaceRoot: string,
  identifier: string,
  query: TraceQuery,
): Effect.Effect<TracePage> => {
  if (!store.enabled) {
    return Effect.succeed(emptyPage(store, identifier, query.after))
  }
  const root = traceRoot(workspaceRoot)
  const identifierKey = workspaceKey(issueIdentifier(identifier))
  return store
    .onHostFileSystem(
      Effect.all({
        collected: collect(root, identifierKey, query),
        evictions: loadEvictions(evictionPath(workspaceRoot)).pipe(
          Effect.catchAll(() => Effect.succeed(emptyEvictionLog)),
        ),
      }),
    )
    .pipe(
      Effect.map(
        ({ collected, evictions }): TracePage => ({
          enabled: store.enabled,
          identifier,
          events: collected.events,
          nextAfter: collected.events.at(-1)?.sequence ?? query.after,
          hasMore: collected.hasMore,
          malformedRecords: collected.malformed,
          limits: store.limits,
          evictions: evictions.evictions,
          evictionsTotal: evictions.total,
        }),
      ),
      Effect.catchAll(() => Effect.succeed(emptyPage(store, identifier, query.after))),
    )
}

/** A query with every filter off, for a caller that only wants the next page. */
export const traceQuery = (overrides: Partial<TraceQuery> = {}): TraceQuery => ({
  after: 0,
  limit: tracePageLimit,
  categories: null,
  outcomes: null,
  attempt: null,
  turnId: null,
  ...overrides,
})
