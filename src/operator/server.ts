import * as HttpApp from '@effect/platform/HttpApp'
import * as HttpRouter from '@effect/platform/HttpRouter'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { Cause, Chunk, Effect, Option, type Scope } from 'effect'

import { ServerError } from '@symphony/core/domain/errors.js'
import { logError } from '@symphony/core/support/logging.js'
import { publishIssueDetail, publishRefresh, publishState } from './api.js'
import type { OperatorBackend, OperatorBackendError } from './operator.js'
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

const json = (status: number, value: object): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.unsafeJson(value, {
    status,
    contentType: 'application/json; charset=utf-8',
  })

const errorResponse = (
  status: number,
  code: string,
  message: string,
): HttpServerResponse.HttpServerResponse =>
  json(status, { version: 'v1', error: { code, message } })

const tokenMatches = (actual: string | undefined, expected: string): boolean => {
  if (actual === undefined) {
    return false
  }
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

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

const backendFailure = errorResponse(
  502,
  'backend_error',
  'The operator backend could not complete the request',
)

const notFound = errorResponse(404, 'not_found', 'The requested endpoint does not exist')

/**
 * SPEC 13.7.2 reserves this for an issue unknown to the current in-memory state. Everything the
 * runtime still knows resolves instead, including work that has moved on to the pull-request
 * handoff lifecycle.
 */
const unknownIssue = errorResponse(
  404,
  'issue_not_found',
  'That identifier is not known to this host',
)

const runBackend = <Value>(
  operation: Effect.Effect<Value, OperatorBackendError>,
): Effect.Effect<Value | HttpServerResponse.HttpServerResponse> =>
  operation.pipe(Effect.catchAll(() => Effect.succeed(backendFailure)))

/**
 * `Allow` states what the URI serves, not what one route serves. Two routes can share a path when
 * their methods differ, and a refusal that named only one of them would report the other as
 * unavailable.
 */
const methodNotAllowed = (
  allowed: readonly [string, ...string[]],
): HttpServerResponse.HttpServerResponse =>
  errorResponse(405, 'method_not_allowed', `Use ${allowed.join(' or ')} for this endpoint`).pipe(
    HttpServerResponse.setHeader('Allow', allowed.join(', ')),
  )

const withMethod = <Error, Requirements>(
  method: 'GET' | 'POST',
  handler: HttpApp.Default<Error, Requirements>,
): HttpApp.Default<Error, Requirements> =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    request.method === method ? handler : methodNotAllowed([method]),
  )

const withCsrf = <Error, Requirements>(
  csrfToken: string,
  handler: HttpApp.Default<Error, Requirements>,
): HttpApp.Default<Error, Requirements> =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    tokenMatches(request.headers['x-symphony-csrf'], csrfToken)
      ? handler
      : errorResponse(403, 'invalid_csrf_token', 'The request token is missing or invalid'),
  )

/**
 * Exported so the reserved-identifier guard in `test/operator/server.test.ts` can read the
 * registrations themselves rather than the source that spells them. What shadows an issue
 * identifier is the path a route ends up registered at, however it was written, so the router value
 * is the only honest source for the set of names the namespace reserves.
 */
export const makeRouter = (
  backend: OperatorBackend,
  csrfToken: string,
): HttpRouter.HttpRouter<never, never> => {
  const issueAction = (
    enabled: boolean,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpRouter.RouteContext | HttpServerRequest.HttpServerRequest
  > =>
    Effect.flatMap(HttpRouter.params, (params) => {
      const encodedIssueNumber = params['issueNumber'] ?? ''
      if (!/^\d+$/u.test(encodedIssueNumber)) {
        return notFound
      }
      const issueNumber = Number(encodedIssueNumber)
      return withMethod(
        'POST',
        withCsrf(
          csrfToken,
          Effect.flatMap(runBackend(backend.setIssueEnabled(issueNumber, enabled)), (result) =>
            HttpServerResponse.isServerResponse(result)
              ? result
              : json(202, { accepted: true, issueNumber, enabled }),
          ),
        ),
      )
    })

  const fixedRoutes = HttpRouter.empty.pipe(
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
    HttpRouter.all(
      '/api/v1/state',
      withMethod(
        'GET',
        Effect.flatMap(runBackend(backend.snapshot), (result) =>
          HttpServerResponse.isServerResponse(result) ? result : json(200, publishState(result)),
        ),
      ),
    ),
    HttpRouter.all(
      '/api/v1/backlog',
      withMethod(
        'GET',
        Effect.flatMap(runBackend(backend.backlog), (result) =>
          HttpServerResponse.isServerResponse(result) ? result : json(200, result),
        ),
      ),
    ),
    // Registered for POST alone rather than for every method, unlike the two above it. The method
    // is what tells this route apart from the per-issue resource at the same path, so a GET falls
    // through to the wildcard and an issue identified `refresh` stays addressable. Answering GET
    // here with a 405 would reserve that identifier for no reason: the SPEC gives this path a POST
    // and gives GET to the per-issue resource, so both are served as the SPEC spells them.
    HttpRouter.post(
      '/api/v1/refresh',
      withCsrf(
        csrfToken,
        Effect.flatMap(runBackend(backend.refresh), (result) =>
          HttpServerResponse.isServerResponse(result) ? result : json(202, publishRefresh(result)),
        ),
      ),
    ),
    HttpRouter.all('/api/v1/issues/:issueNumber/start', issueAction(true)),
    HttpRouter.all('/api/v1/issues/:issueNumber/pause', issueAction(false)),
    // Everything above is a fixed path; the per-issue resource below is the wildcard they sit in
    // front of.
    HttpRouter.all(
      '/api/v1/agents/:identifier',
      withMethod(
        'GET',
        // As with the baseline resource, the identifier is not matched against a shape: this route is
        // what a published `detail_url` points at, so a pattern here would make a tracker's own
        // inspection resource unreachable for the identifiers it spells. The lookup distinguishes
        // the four outcomes, and an identifier this session has never run is `404 agent_not_found`
        // whether it is unknown or unspellable.
        Effect.flatMap(HttpRouter.params, (params) => {
          const identifier = params['identifier'] ?? ''
          return Effect.map(backend.agentDetail(identifier), (lookup) => {
            switch (lookup._tag) {
              case 'Found': {
                return json(200, { version: 'v1', detail: lookup.detail })
              }
              case 'Completed': {
                return errorResponse(
                  410,
                  'agent_session_completed',
                  'The agent session has completed and its detail is no longer retained',
                )
              }
              case 'NoSession': {
                return errorResponse(
                  409,
                  'agent_not_active',
                  'The issue has no active or retrying agent session',
                )
              }
              case 'Unavailable': {
                return errorResponse(503, 'agent_detail_unavailable', lookup.reason).pipe(
                  HttpServerResponse.setHeader('Retry-After', '1'),
                )
              }
              case 'Unknown': {
                return errorResponse(
                  404,
                  'agent_not_found',
                  'No agent has run for that identifier in this session',
                )
              }
            }
          })
        }),
      ),
    ),
  )

  /**
   * The methods a fixed path answers on its own, read from the registrations above rather than
   * restated beside them. A route registered for one method leaves the other methods of its path to
   * the per-issue resource below, so the two share a URI and a refusal there has to name both. A
   * route registered for every method (`HttpRouter.all`) never falls through and contributes
   * nothing.
   */
  const methodsBesideIssueResource = new Map<string, readonly string[]>()
  for (const route of Chunk.toReadonlyArray(fixedRoutes.routes)) {
    if (route.method === '*') {
      continue
    }
    const path = `${Option.getOrElse(route.prefix, () => '')}${route.path}`
    methodsBesideIssueResource.set(path, [
      ...(methodsBesideIssueResource.get(path) ?? []),
      route.method,
    ])
  }

  return fixedRoutes.pipe(
    // The wildcard sits below the fixed routes above it, so the two GET names they spell —
    // `state` and `backlog` — are unaddressable as issue identifiers: a GET of either path cannot
    // be told apart from a GET of the resource below. SPEC 13.7.2 puts both resources in one
    // namespace, so that collision is inherent to the URL design rather than to this registration
    // order; #220 recorded it as a known limit and left it unhandled, because resolving it means
    // changing a SPEC route's URL for identifiers no tracker profile can currently spell.
    // `README.md` carries the decision and the two names, and `test/operator/server.test.ts` pins
    // both what they answer and that the set has not grown.
    HttpRouter.all(
      '/api/v1/:identifier',
      // The identifier is not matched against a shape. `IssueIdentifier` is an unconstrained
      // branded string, and a tracker is free to spell one `GH-7`; a syntactic guard here would
      // decide on GitHub's behalf which providers may reach a SPEC resource. Existence is the only
      // question, and in-memory state is what answers it.
      Effect.flatMap(HttpRouter.params, (params) => {
        const identifier = params['identifier'] ?? ''
        return Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
          if (request.method !== 'GET') {
            // This resource answers GET, and a fixed route may answer another method at the same
            // path — `POST /api/v1/refresh` does. Both belong in `Allow`.
            return methodNotAllowed([
              'GET',
              ...(methodsBesideIssueResource.get(`/api/v1/${identifier}`) ?? []),
            ])
          }
          return Effect.flatMap(runBackend(backend.snapshot), (result) => {
            if (HttpServerResponse.isServerResponse(result)) {
              return result
            }
            return Effect.map(backend.agentDetail(identifier), (lookup) => {
              const detail = publishIssueDetail(identifier, result, lookup)
              return detail === null ? unknownIssue : json(200, detail)
            })
          })
        })
      }),
    ),
  )
}

/**
 * The router's own limit on a path segment. Its default of 100 characters is shorter than a tracker
 * identifier can legitimately be — a GitHub owner and repository together reach 140 — and a segment
 * over the limit fails to match, so a published `detail_url` would 404 before any handler ran.
 */
const maxIdentifierParamLength = 1024

const makeApp = (backend: OperatorBackend, csrfToken: string): HttpApp.Default<never, never> => {
  const handled = makeRouter(backend, csrfToken).pipe(
    HttpRouter.withRouterConfig({ maxParamLength: maxIdentifierParamLength }),
    Effect.catchTag('RouteNotFound', () => Effect.succeed(notFound)),
    Effect.catchAllCause((cause) =>
      logError('operator request failed', { cause: Cause.pretty(cause) }).pipe(
        Effect.as(errorResponse(500, 'internal_error', 'The request could not be completed')),
      ),
    ),
  )

  return Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.map(
      hostIsLoopback(request.headers['host'])
        ? handled
        : Effect.succeed(
            errorResponse(421, 'invalid_host', 'The operator console only accepts loopback hosts'),
          ),
      HttpServerResponse.setHeaders(securityHeaders),
    ),
  )
}

export const startOperatorServer = (
  requestedPort: number,
  backend: OperatorBackend,
): Effect.Effect<OperatorServer, ServerError, Scope.Scope> =>
  Effect.gen(function* () {
    const csrfToken = randomBytes(32).toString('base64url')
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
    yield* server.serve(makeApp(backend, csrfToken))
    if (server.address._tag !== 'TcpAddress') {
      return yield* new ServerError({
        category: 'listen_failed',
        message: 'operator server did not expose a TCP address',
      })
    }
    const port = server.address.port
    return { host, port, url: `http://${host}:${String(port)}` }
  })
