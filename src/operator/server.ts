import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import type * as HttpApp from '@effect/platform/HttpApp'
import * as HttpRouter from '@effect/platform/HttpRouter'
import * as HttpServerError from '@effect/platform/HttpServerError'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { Cause, Effect, Layer, type Scope } from 'effect'

import { ServerError } from '@sloppenheimer/core/domain/errors.js'
import { logError } from '@sloppenheimer/core/support/logging.js'

import {
  operatorApi,
  operatorRoutes,
  pathParameterShapes,
  type OperatorRoute,
} from './api/endpoints.js'
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
 * The console's own files: the page, its two assets, and the generated description of the API
 * beside them. They sit outside the endpoint group deliberately — they are files rather than
 * resources with a schema — and the API document is served here rather than under `/api/v1/`
 * because a name in that namespace shadows an issue identifier spelled the same way.
 *
 * They are listed rather than registered one by one because two things read them: the router that
 * serves them, and the index below that says what each URI serves. A file added to one and not the
 * other would answer a request and then deny its own method.
 */
const consoleFiles = (
  csrfToken: string,
): readonly Readonly<{ path: `/${string}`; contentType: string; body: string }>[] => [
  {
    path: '/',
    contentType: 'text/html; charset=utf-8',
    body: appTemplate.replace('__CSRF_TOKEN__', csrfToken),
  },
  { path: '/app.js', contentType: 'text/javascript; charset=utf-8', body: appJavaScript },
  { path: '/styles.css', contentType: 'text/css; charset=utf-8', body: appStyles },
  {
    path: '/openapi.json',
    contentType: jsonContentType,
    body: JSON.stringify(operatorOpenApiDocument()),
  },
]

const consoleRouter = (
  files: readonly Readonly<{ path: `/${string}`; contentType: string; body: string }>[],
): HttpRouter.HttpRouter<never, never> =>
  files.reduce(
    (router, file) =>
      HttpRouter.get(
        router,
        file.path,
        HttpServerResponse.text(file.body, { contentType: file.contentType }),
      ),
    HttpRouter.empty,
  )

/**
 * Whether one path also answers at another's URIs, which is true when a parameter stands where the
 * other spells a segment. `POST /api/v1/refresh` and the per-issue `GET /api/v1/:identifier` share
 * every URI the first one names.
 *
 * Both sides are path templates from the endpoint definitions, so this compares one statement of
 * the contract with another and never reads a request.
 */
const covers = (general: readonly string[], specific: readonly string[]): boolean =>
  general.length === specific.length &&
  general.every((segment, index) => segment.startsWith(':') || segment === specific[index])

/**
 * What each path serves, read from the registrations themselves rather than restated beside them.
 *
 * `Allow` states what a URI serves rather than what one route does, so a path takes the methods of
 * every route that answers at its URIs — its own, and those of any more general path above it.
 *
 * `HEAD` is served wherever `GET` is, because the router answers one with the other, so it is
 * named here too: a resource that advertised only `GET` would be describing less than it serves.
 * It is not declared on any endpoint, because it is not a thing an endpoint decides.
 *
 * The order is the methods' own, so what the header says does not depend on the order the
 * endpoints happen to be declared in.
 */
const servedMethods = (
  routes: readonly OperatorRoute[],
): ReadonlyMap<`/${string}`, readonly string[]> =>
  new Map(
    [...new Set(routes.map((route) => route.path))].map((path) => {
      const segments = path.split('/')
      const methods = new Set(
        routes
          .filter((route) => covers(route.path.split('/'), segments))
          .map((route) => route.method),
      )
      if (methods.has('GET')) {
        methods.add('HEAD')
      }
      return [path, [...methods].sort((left, right) => left.localeCompare(right))]
    }),
  )

/** The methods as a refusal names them, which is a sentence rather than a header. */
const spelled = (methods: readonly string[]): string =>
  methods.length < 2
    ? methods.join('')
    : `${methods.slice(0, -1).join(', ')} or ${methods[methods.length - 1] ?? ''}`

/**
 * Whether the parameters the router read name a resource this API can address.
 *
 * The router has already decided the rest: it decoded each parameter, refused a segment it could
 * not read, and applied its own length bound, so what is left is the one thing only the contract
 * knows — that the console's eligibility controls name an issue by number.
 */
const addressableParameters = (params: Readonly<Record<string, string | undefined>>): boolean =>
  Object.entries(params).every(([name, value]) => {
    const shape = pathParameterShapes.get(name)
    return shape === undefined || (value !== undefined && shape.test(value))
  })

/**
 * What a URI that names a resource answers for a method it does not serve. A parameter the
 * contract cannot address names no resource, so that is a `404` rather than a `405` advertising
 * something that does not exist.
 */
const methodRefusal = (
  served: readonly string[],
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpRouter.RouteContext> =>
  Effect.flatMap(HttpRouter.params, (params) =>
    addressableParameters(params)
      ? failureResponse(
          methodNotAllowed,
          methodNotAllowed.withMessage(`Use ${spelled(served)} for this endpoint`),
        ).pipe(Effect.map(HttpServerResponse.setHeader('Allow', served.join(', '))))
      : failureResponse(notFound, notFound.failure),
  )

/**
 * The answer for a request nothing served: a `405` naming what the URI does serve, or a `404` when
 * it names nothing at all.
 *
 * This is a router over the same paths, so the question "what does this URI serve" is answered by
 * the matcher that decides what serves it — the same segment matching, the same parameter
 * decoding, the same bound on a parameter's length. A hand-written reading of the paths beside it
 * could disagree with the real one; this cannot.
 */
const unclaimedRequest = (
  routes: readonly OperatorRoute[],
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  [...servedMethods(routes)]
    .reduce(
      (router, [path, served]) => HttpRouter.all(router, path, methodRefusal(served)),
      HttpRouter.empty,
    )
    .pipe(
      HttpRouter.withRouterConfig({ maxParamLength: maxIdentifierParamLength }),
      Effect.catchTag('RouteNotFound', () => failureResponse(notFound, notFound.failure)),
    )

/**
 * The endpoint group's answer, or the fact that it had none.
 *
 * `HttpApiBuilder.httpApp` is typed as never failing, and it does encode every error its endpoints
 * declare into a response. What it still puts on the failure channel is its router's own
 * `RouteNotFound`, for a URI no endpoint claims — the one outcome that type does not describe — so
 * that is what this reads it as. Anything else is a defect this host has no reading for, and is
 * left to the cause handler above it. A defect is not caught here at all: `catchAll` takes the
 * failure channel, and a died fiber keeps its cause.
 */
const servedOrUnclaimed = (
  apiApp: HttpApp.Default<never, never>,
  unclaimed: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >,
): HttpApp.Default<never, never> =>
  Effect.catchAll(apiApp, (error: unknown) =>
    error instanceof HttpServerError.RouteNotFound ? unclaimed : Effect.die(error),
  )

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
    const files = consoleFiles(csrfToken)
    const unclaimed = unclaimedRequest([
      ...files.map((file): OperatorRoute => ({ method: 'GET', path: file.path })),
      ...operatorRoutes,
    ])

    // The console's own files answer first, then the endpoint group, and a request neither served
    // is refused last — because what a URI serves is a property of every registration together
    // rather than of the one that happened to be asked.
    const routed = consoleRouter(files).pipe(
      Effect.catchTag('RouteNotFound', () =>
        Effect.flatMap(servedOrUnclaimed(apiApp, unclaimed), publishableDocument),
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
