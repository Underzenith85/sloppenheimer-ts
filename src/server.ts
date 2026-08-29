import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Effect, type Scope } from 'effect'

import { ServerError } from './errors.js'
import type { OperatorBackend } from './operator.js'
import { appJavaScript, appStyles, appTemplate } from './ui-assets.js'

const host = '127.0.0.1'

export type OperatorServer = Readonly<{
  host: typeof host
  port: number
  url: string
}>

type ServerResource = OperatorServer & Readonly<{ close: () => Promise<void> }>

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const

const send = (
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, {
    ...securityHeaders,
    ...extraHeaders,
    'Content-Type': contentType,
  })
  response.end(body)
}

const sendJson = (response: ServerResponse, status: number, value: object): void => {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

const sendError = (
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void => {
  sendJson(response, status, { version: 'v1', error: { code, message } })
}

const tokenMatches = (actual: string | undefined, expected: string): boolean => {
  if (actual === undefined) {
    return false
  }
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

const headerValue = (value: string | readonly string[] | undefined): string | undefined => {
  if (typeof value === 'string') {
    return value
  }
  return undefined
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

const runBackend = async <Value>(
  response: ServerResponse,
  operation: Effect.Effect<Value, { readonly message: string }>,
  onSuccess: (value: Value) => void,
): Promise<void> => {
  const result = await Effect.runPromiseExit(operation)
  if (result._tag === 'Failure') {
    sendError(response, 502, 'backend_error', 'The operator backend could not complete the request')
    return
  }
  onSuccess(result.value)
}

const methodNotAllowed = (response: ServerResponse, allowed: string): void => {
  send(
    response,
    405,
    'application/json; charset=utf-8',
    JSON.stringify({
      version: 'v1',
      error: { code: 'method_not_allowed', message: `Use ${allowed} for this endpoint` },
    }),
    { Allow: allowed },
  )
}

const issueAction = /^\/api\/v1\/issues\/(\d+)\/(start|pause)$/u
const issueDetail = /^\/api\/v1\/([^/]+)$/u

const makeHandler =
  (backend: OperatorBackend, csrfToken: string) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', `http://${host}`)
    const path = url.pathname

    if (!hostIsLoopback(headerValue(request.headers.host))) {
      sendError(response, 421, 'invalid_host', 'The operator console only accepts loopback hosts')
      return
    }

    if (path === '/' && method === 'GET') {
      send(
        response,
        200,
        'text/html; charset=utf-8',
        appTemplate.replace('__CSRF_TOKEN__', csrfToken),
      )
      return
    }
    if (path === '/app.js' && method === 'GET') {
      send(response, 200, 'text/javascript; charset=utf-8', appJavaScript)
      return
    }
    if (path === '/styles.css' && method === 'GET') {
      send(response, 200, 'text/css; charset=utf-8', appStyles)
      return
    }
    if (path === '/api/v1/state') {
      if (method !== 'GET') {
        methodNotAllowed(response, 'GET')
        return
      }
      await runBackend(response, backend.snapshot, (snapshot) => {
        sendJson(response, 200, snapshot)
      })
      return
    }
    if (path === '/api/v1/backlog') {
      if (method !== 'GET') {
        methodNotAllowed(response, 'GET')
        return
      }
      await runBackend(response, backend.backlog, (backlog) => {
        sendJson(response, 200, backlog)
      })
      return
    }
    if (path === '/api/v1/refresh') {
      if (method !== 'POST') {
        methodNotAllowed(response, 'POST')
        return
      }
      if (!tokenMatches(headerValue(request.headers['x-symphony-csrf']), csrfToken)) {
        sendError(response, 403, 'invalid_csrf_token', 'The request token is missing or invalid')
        return
      }
      await runBackend(response, backend.refresh, () => {
        sendJson(response, 202, { accepted: true })
      })
      return
    }

    const actionMatch = issueAction.exec(path)
    if (actionMatch !== null) {
      if (method !== 'POST') {
        methodNotAllowed(response, 'POST')
        return
      }
      if (!tokenMatches(headerValue(request.headers['x-symphony-csrf']), csrfToken)) {
        sendError(response, 403, 'invalid_csrf_token', 'The request token is missing or invalid')
        return
      }
      const issueNumber = Number(actionMatch[1])
      const enabled = actionMatch[2] === 'start'
      await runBackend(response, backend.setIssueEnabled(issueNumber, enabled), () => {
        sendJson(response, 202, { accepted: true, issueNumber, enabled })
      })
      return
    }

    const detailMatch = issueDetail.exec(path)
    if (detailMatch !== null) {
      if (method !== 'GET') {
        methodNotAllowed(response, 'GET')
        return
      }
      const identifier = decodeURIComponent(detailMatch[1] ?? '')
      await runBackend(response, backend.snapshot, (snapshot) => {
        const running = snapshot.running.find((entry) => entry.identifier === identifier)
        const retrying = snapshot.retrying.find((entry) => entry.identifier === identifier)
        if (running === undefined && retrying === undefined) {
          sendError(response, 404, 'issue_not_found', 'No live work has that identifier')
          return
        }
        sendJson(response, 200, {
          identifier,
          running: running ?? null,
          retrying: retrying ?? null,
        })
      })
      return
    }

    sendError(response, 404, 'not_found', 'The requested endpoint does not exist')
  }

export const startOperatorServer = (
  requestedPort: number,
  backend: OperatorBackend,
): Effect.Effect<OperatorServer, ServerError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.async<ServerResource, ServerError>((resume) => {
      const csrfToken = randomBytes(32).toString('base64url')
      const server = createServer((request, response) => {
        makeHandler(backend, csrfToken)(request, response).catch(() => {
          if (!response.headersSent) {
            sendError(response, 500, 'internal_error', 'The request could not be completed')
          } else {
            response.end()
          }
        })
      })
      const onListenError = (cause: Error): void => {
        resume(
          Effect.fail(
            new ServerError({
              category: 'listen_failed',
              message: 'operator server failed',
              cause,
            }),
          ),
        )
      }
      server.once('error', onListenError)
      server.listen(requestedPort, host, () => {
        server.removeListener('error', onListenError)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          resume(
            Effect.fail(
              new ServerError({
                category: 'listen_failed',
                message: 'operator server did not expose a TCP address',
              }),
            ),
          )
          return
        }
        const port = address.port
        resume(
          Effect.succeed({
            host,
            port,
            url: `http://${host}:${String(port)}`,
            close: () =>
              new Promise<void>((resolve, reject) => {
                server.close((error) => {
                  if (error === undefined) {
                    resolve()
                  } else {
                    reject(error)
                  }
                })
              }),
          }),
        )
      })
    }),
    (resource) =>
      Effect.tryPromise({
        try: resource.close,
        catch: (cause: unknown) =>
          new ServerError({
            category: 'close_failed',
            message: 'operator server failed to close',
            cause,
          }),
      }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning('operator server failed to close', { error: error.message }),
        ),
      ),
  ).pipe(Effect.map(({ host: boundHost, port, url }) => ({ host: boundHost, port, url })))
