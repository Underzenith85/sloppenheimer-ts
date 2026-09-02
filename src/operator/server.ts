import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import type * as HttpApp from '@effect/platform/HttpApp'
import * as HttpRouter from '@effect/platform/HttpRouter'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { Cause, Effect, Layer, type Scope } from 'effect'

import { ServerError } from '@sloppenheimer/core/domain/errors.js'
import { logError } from '@sloppenheimer/core/support/logging.js'

import { operatorApi, operatorRoutes, pathParameterShapes } from './api/endpoints.js'
import {
  failureResponse,
  internalError,
  invalidHost,
  methodNotAllowed,
  notFound,
} from './api/errors.js'
import { jsonContentType } from './api/media.js'
import { operatorHandlers } from './handlers.js'
import { operatorOpenApiDocument } from './openapi.js'
import type { OperatorBackend } from './operator.js'
import { appJavaScript, appStyles, appTemplate } from './ui-assets.js'

const host = '127.0.0.1'

export type OperatorServer = Readonly<{
  host: typeof host
  port: number
  url: string
}>

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const

/**
 * The router's own limit on a path segment. Its default of 100 characters is shorter than a tracker
 * identifier can legitimately be — a GitHub owner and repository together reach 140 — and a segment
 * over the limit fails to match, so a published `detail_url` would 404 before any handler ran.
 */
const maxIdentifierParamLength = 1024

const hostIsLoopback = (value: string | undefined): boolean => {
  if (value === undefined) {
    return false
  }
  try {
    const hostname = new URL(`http://${value}`).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * The console itself: the page, its two assets, and the generated description of the API beside
 * them. These sit outside the endpoint group deliberately — they are files rather than resources
 * with a schema, and the API document is served here rather than under `/api/v1/` because a name
 * in that namespace shadows an issue identifier spelled the same way.
 */
const consoleRoutes = (csrfToken: string): HttpRouter.HttpRouter<never, never> =>
  HttpRouter.empty.pipe(
    HttpRouter.get(
      '/',
      HttpServerResponse.text(appTemplate.replace('__CSRF_TOKEN__', csrfToken), {
        contentType: 'text/html; charset=utf-8',
      }),
    ),
    HttpRouter.get(
      '/app.js',
      HttpServerResponse.text(appJavaScript, {
        contentType: 'text/javascript; charset=utf-8',
      }),
    ),
    HttpRouter.get(
      '/styles.css',
      HttpServerResponse.text(appStyles, { contentType: 'text/css; charset=utf-8' }),
    ),
    HttpRouter.get(
      '/openapi.json',
      HttpServerResponse.unsafeJson(operatorOpenApiDocument(), {
        contentType: jsonContentType,
      }),
    ),
  )

/**
 * A path parameter as the router will hand it to a handler. A malformed escape has no such
 * reading, and a segment that has none names nothing.
 */
const decodedSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

/**
 * Whether one path parameter, spelled this way, names a resource this API can address.
 *
 * Every parameter has to have a reading at all: a segment carrying a malformed escape names
 * nothing, and the router will not match one either, so accepting it here would hand the API a
 * request it cannot route and turn an unaddressable URI into a failure rather than a `404`.
 *
 * The length is judged before decoding, because that is what the router itself bounds, and the
 * shape after, because the reading is the value the router hands the handler. A parameter with no
 * declared shape only has to have one — an identifier is a branded string a tracker is free to
 * spell `GH-7`, so a pattern would decide on GitHub's behalf which providers may reach a SPEC
 * resource.
 */
const addressableParameter = (name: string, segment: string): boolean => {
  if (segment.length === 0 || segment.length > maxIdentifierParamLength) {
    return false
  }
  const decoded = decodedSegment(segment)
  if (decoded === undefined) {
    return false
  }
  const shape = pathParameterShapes.get(name)
  return shape === undefined || shape.test(decoded)
}

/**
 * Whether one endpoint claims a request path: the path has its shape, and every parameter it names
 * is addressable. An unaddressable parameter leaves the path unclaimed rather than claimed by the
 * method that would have served it, so a URI that names no resource is a `404` on every method
 * rather than a `405` advertising a resource that does not exist.
 */
const claimsPath = (routeSegments: readonly string[], segments: readonly string[]): boolean =>
  routeSegments.length === segments.length &&
  routeSegments.every((routeSegment, index) => {
    const segment = segments[index] ?? ''
    return routeSegment.startsWith(':')
      ? addressableParameter(routeSegment.slice(1), segment)
      : routeSegment === segment
  })

const routeMatchers: readonly Readonly<{ segments: readonly string[]; method: string }>[] =
  operatorRoutes.map((route) => ({ segments: route.path.split('/'), method: route.method }))

const requestPath = (url: string): string => {
  const query = url.indexOf('?')
  return query === -1 ? url : url.slice(0, query)
}

/**
 * The methods a URI answers, read from the endpoint definitions rather than restated beside them.
 * Two endpoints can share a path when their methods differ — `POST /api/v1/refresh` and the
 * per-issue resource below it do — and a refusal that named only one of them would report the
 * other as unavailable. The order is the methods' own rather than the definitions', so what the
 * `Allow` header says does not depend on the order the endpoints happen to be declared in.
 */
const answeredMethods = (path: string): readonly string[] => {
  const segments = path.split('/')
  return [
    ...new Set(
      routeMatchers
        .filter((route) => claimsPath(route.segments, segments))
        .map((route) => route.method),
    ),
  ].sort((left, right) => left.localeCompare(right))
}

/**
 * What a request no endpoint claims is answered with: a `404` when the URI names nothing, and a
 * `405` naming every method the URI does answer when it names a resource this method cannot reach.
 */
const unclaimedRequest = (
  answered: readonly string[],
): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  if (answered.length === 0) {
    return failureResponse(notFound, notFound.failure)
  }
  return failureResponse(
    methodNotAllowed,
    methodNotAllowed.withMessage(`Use ${answered.join(' or ')} for this endpoint`),
  ).pipe(Effect.map(HttpServerResponse.setHeader('Allow', answered.join(', '))))
}

/**
 * The endpoint group as an application, with the router configured for the identifiers this API
 * addresses. The layer graph is built into the caller's scope, so the handlers and the router live
 * exactly as long as the listener does.
 */
const makeApiApp = (
  backend: OperatorBackend,
  csrfToken: string,
): Effect.Effect<HttpApp.Default<never, never>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const built = yield* Layer.build(
      Layer.mergeAll(
        HttpApiBuilder.api(operatorApi).pipe(Layer.provide(operatorHandlers(backend, csrfToken))),
        HttpApiBuilder.Router.Live,
        HttpApiBuilder.Middleware.layer,
        NodeHttpServer.layerContext,
      ),
    )
    const app = yield* HttpApiBuilder.httpApp.pipe(
      HttpRouter.withRouterConfig({ maxParamLength: maxIdentifierParamLength }),
      Effect.provide(built),
    )
    return Effect.provide(app, built)
  })

/**
 * The one status the endpoint group never means.
 *
 * This API reads no request body, no query parameters and no constrained path parameter, so nothing
 * a caller sends can fail to decode and no endpoint declares a `400`. What the platform does report
 * that way is a *response* that failed the schema its own endpoint declared — a document the
 * mapping promised and did not produce. That is this host's defect rather than the caller's
 * request, and the parse detail it carries is exactly what this API sanitizes, so the document is
 * withheld and the internal error published in its place.
 */
const publishableDocument = (
  response: HttpServerResponse.HttpServerResponse,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  response.status === 400
    ? logError('operator response did not match its published contract', {
        action: 'publish_operator_document',
        outcome: 'failed',
      }).pipe(Effect.zipRight(failureResponse(internalError, internalError.failure)))
    : Effect.succeed(response)

const makeApp = (
  backend: OperatorBackend,
  csrfToken: string,
): Effect.Effect<HttpApp.Default<never, never>, never, Scope.Scope> =>
  Effect.map(makeApiApp(backend, csrfToken), (apiApp) => {
    // The console's own files answer first; everything else is the API's, and a URI the API does
    // not claim is refused here rather than inside it, because what a URI answers is a property of
    // the endpoint definitions rather than of any one endpoint.
    const routed = consoleRoutes(csrfToken).pipe(
      Effect.catchTag('RouteNotFound', () =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
          const answered = answeredMethods(requestPath(request.url))
          return answered.includes(request.method)
            ? Effect.flatMap(apiApp, publishableDocument)
            : unclaimedRequest(answered)
        }),
      ),
      Effect.catchAllCause((cause) =>
        logError('operator request failed', { cause: Cause.pretty(cause) }).pipe(
          Effect.zipRight(failureResponse(internalError, internalError.failure)),
        ),
      ),
    )

    return Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Effect.map(
        hostIsLoopback(request.headers['host'])
          ? routed
          : failureResponse(invalidHost, invalidHost.failure),
        HttpServerResponse.setHeaders(securityHeaders),
      ),
    )
  })

export const startOperatorServer = (
  requestedPort: number,
  backend: OperatorBackend,
): Effect.Effect<OperatorServer, ServerError, Scope.Scope> =>
  Effect.gen(function* () {
    const csrfToken = randomBytes(32).toString('base64url')
    const app = yield* makeApp(backend, csrfToken)
    const server = yield* NodeHttpServer.make(() => createServer(), {
      host,
      port: requestedPort,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerError({
            category: 'listen_failed',
            message: 'operator server failed',
            cause,
          }),
      ),
    )
    yield* server.serve(app)
    if (server.address._tag !== 'TcpAddress') {
      return yield* new ServerError({
        category: 'listen_failed',
        message: 'operator server did not expose a TCP address',
      })
    }
    const port = server.address.port
    return { host, port, url: `http://${host}:${String(port)}` }
  })
