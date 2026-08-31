import * as HttpApp from '@effect/platform/HttpApp'
import * as HttpRouter from '@effect/platform/HttpRouter'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { Cause, Effect, type Scope } from 'effect'

import { ServerError } from '@symphony/core/domain/errors.js'
import { logError } from '@symphony/core/support/logging.js'
import { publishRefresh, publishRetrying, publishRunning, publishState } from './api.js'
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

/**
 * The shape a tracker identifier may take. Rejecting anything else keeps a malformed path from
 * reaching the actor at all, and keeps the reflected error free of caller-supplied text.
 *
 * The length bound only excludes paths no tracker could have produced: a GitHub owner and
 * repository can together run to 140 characters, and a `detail_url` the runtime snapshot publishes
 * must never be rejected by the endpoint it points at.
 */
const issueIdentifierPattern = /^[\w.\-/]{1,512}#\d{1,12}$/u

const isIssueIdentifier = (value: string): boolean => issueIdentifierPattern.test(value)

const backendFailure = errorResponse(
  502,
  'backend_error',
  'The operator backend could not complete the request',
)

const notFound = errorResponse(404, 'not_found', 'The requested endpoint does not exist')

const runBackend = <Value>(
  operation: Effect.Effect<Value, OperatorBackendError>,
): Effect.Effect<Value | HttpServerResponse.HttpServerResponse> =>
  operation.pipe(Effect.catchAll(() => Effect.succeed(backendFailure)))

const methodNotAllowed = (allowed: string): HttpServerResponse.HttpServerResponse =>
  errorResponse(405, 'method_not_allowed', `Use ${allowed} for this endpoint`).pipe(
    HttpServerResponse.setHeader('Allow', allowed),
  )

const withMethod = <Error, Requirements>(
  method: 'GET' | 'POST',
  handler: HttpApp.Default<Error, Requirements>,
): HttpApp.Default<Error, Requirements> =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    request.method === method ? handler : methodNotAllowed(method),
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

const makeRouter = (
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

  return HttpRouter.empty.pipe(
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
    HttpRouter.all(
      '/api/v1/refresh',
      withMethod(
        'POST',
        withCsrf(
          csrfToken,
          Effect.flatMap(runBackend(backend.refresh), (result) =>
            HttpServerResponse.isServerResponse(result)
              ? result
              : json(202, publishRefresh(result)),
          ),
        ),
      ),
    ),
    HttpRouter.all('/api/v1/issues/:issueNumber/start', issueAction(true)),
    HttpRouter.all('/api/v1/issues/:issueNumber/pause', issueAction(false)),
    HttpRouter.all(
      '/api/v1/agents/:identifier',
      withMethod(
        'GET',
        Effect.flatMap(HttpRouter.params, (params) => {
          const identifier = params['identifier'] ?? ''
          if (!isIssueIdentifier(identifier)) {
            return errorResponse(
              400,
              'invalid_identifier',
              'The agent identifier is not a valid issue identifier',
            )
          }
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
    HttpRouter.all(
      '/api/v1/:identifier',
      withMethod(
        'GET',
        Effect.flatMap(HttpRouter.params, (params) =>
          Effect.flatMap(runBackend(backend.snapshot), (result) => {
            if (HttpServerResponse.isServerResponse(result)) {
              return result
            }
            const identifier = params['identifier'] ?? ''
            const running = result.running.find((entry) => entry.identifier === identifier)
            const retrying = result.retrying.find((entry) => entry.identifier === identifier)
            return running === undefined && retrying === undefined
              ? errorResponse(404, 'issue_not_found', 'No live work has that identifier')
              : json(200, {
                  issue_identifier: identifier,
                  running: running === undefined ? null : publishRunning(running),
                  retrying: retrying === undefined ? null : publishRetrying(retrying),
                })
          }),
        ),
      ),
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
