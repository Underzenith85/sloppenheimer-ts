import * as HttpRouter from '@effect/platform/HttpRouter'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import { Effect, Stream } from 'effect'

import { tracePageLimit } from '@sloppenheimer/core'
import { publishTrace, publishTraceEvent, traceQueryFrom } from './api.js'
import type { OperatorBackend } from './operator.js'

/**
 * The two durable-trace resources: one page of history, and the live tail beside it.
 *
 * They are separate from `server.ts` for size, and separate from the agent-detail resource for a
 * reason worth stating. Detail is a snapshot the runtime already holds and republishes on every
 * transition; a trace is a session's complete activity, read from disk and paged. Serving them from
 * one document would mean building a whole session's messages, command output and tool payloads
 * before any of it could be sent.
 *
 * **Both require the console token.** Every other GET on this server is guarded only by the
 * loopback host check, which is right for a health summary. A trace is not a summary: it carries
 * complete agent output, and the redaction that guards it is heuristic by construction. Requiring
 * the token — which is issued into the console's own HTML and is unreadable to any other origin —
 * is what keeps a page the operator merely visited from reading it. That is also why the live tail
 * is `fetch`-and-read rather than `EventSource`: `EventSource` cannot send a header, and moving the
 * token into a query string would put it in every log and history the browser keeps.
 */

/** Server-sent events, framed. One record per message, and the sequence as the event id. */
const encoder = new TextEncoder()

const eventFrame = (id: number, payload: unknown): Uint8Array =>
  encoder.encode(`id: ${String(id)}\ndata: ${JSON.stringify(payload)}\n\n`)

/**
 * The first frame of a stream, sent before any record.
 *
 * It exists so the console can tell "connected, nothing has happened yet" from "still connecting":
 * without it a live agent that is quiet for a minute is indistinguishable from a stream that never
 * opened, and the console would have no honest thing to show.
 */
const openFrame = encoder.encode(': open\n\n')

// The stream is chunked and incremental; a proxy that buffered it would defeat the point.
const streamHeaders = { 'X-Accel-Buffering': 'no' } as const

export type TraceRouteContext = HttpRouter.RouteContext | HttpServerRequest.HttpServerRequest

/**
 * What the server wraps both routes in: the method check and the console token. It is a parameter
 * rather than something these routes apply themselves, so the refusal vocabulary stays in one
 * place — `server.ts` owns what a 403 and a 405 look like on this API.
 */
export type TraceGuard = <Error, Requirements>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Error, Requirements>,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Error,
  Requirements | HttpServerRequest.HttpServerRequest
>

/**
 * One page of history.
 *
 * The filters are read off the query string so that the console's own filter state is a link an
 * operator can share, and a parameter this host does not understand is refused by name rather than
 * ignored — a filter silently narrowed to what happened to be recognized shows fewer events than
 * were asked for and gives no way to tell.
 */
export const tracePageRoute = (
  backend: OperatorBackend,
  guard: TraceGuard,
  refuse: (parameter: string) => HttpServerResponse.HttpServerResponse,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, TraceRouteContext> =>
  guard(
    Effect.gen(function* () {
      const parameters = yield* HttpRouter.params
      const request = yield* HttpServerRequest.HttpServerRequest
      const identifier = parameters['identifier'] ?? ''
      // A relative request target needs a base to parse against; the base is discarded, and only
      // the search parameters are read from it.
      const search = new URL(request.url, 'http://operator.invalid').searchParams
      const query = traceQueryFrom(search, tracePageLimit)
      if (query._tag === 'Invalid') {
        return refuse(query.parameter)
      }
      const page = yield* backend.agentTrace(identifier, query.query)
      return HttpServerResponse.unsafeJson(publishTrace(page), {
        status: 200,
        contentType: 'application/json; charset=utf-8',
      })
    }),
  )

/**
 * The live tail.
 *
 * It is a tail rather than a replay: a subscriber sees what is written from the moment it attaches,
 * and pages the resource above for what came before. A stream that replayed the history would have
 * to hold a whole session in memory to open, which is the one thing the durable trace exists to
 * avoid.
 */
export const traceStreamRoute = (
  backend: OperatorBackend,
  guard: TraceGuard,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, TraceRouteContext> =>
  guard(
    Effect.map(HttpRouter.params, (parameters) => {
      const identifier = parameters['identifier'] ?? ''
      const records = Stream.map(backend.agentTraceStream(identifier), (event) =>
        eventFrame(event.sequence, publishTraceEvent(event)),
      )
      return HttpServerResponse.stream(Stream.concat(Stream.make(openFrame), records), {
        contentType: 'text/event-stream; charset=utf-8',
      }).pipe(HttpServerResponse.setHeaders(streamHeaders))
    }),
  )
