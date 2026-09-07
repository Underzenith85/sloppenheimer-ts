/** This read-only browser boundary binds only IPv4 loopback and trusts no proxy headers. */
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import { createServer } from 'node:http'
import { Effect, type Scope } from 'effect'
import { ServerError } from '@sloppenheimer/core/domain/errors.js'
import type { Asset } from './assets.js'
import { Registry } from './registry.js'

const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

export const startCoordinatorServer = (
  requestedPort: number,
  assets: ReadonlyMap<string, Asset>,
): Effect.Effect<Readonly<{ port: number; url: string }>, ServerError, Scope.Scope | Registry> =>
  Effect.gen(function* () {
    const registry = yield* Registry
    const server = yield* NodeHttpServer.make(() => createServer(), {
      host: '127.0.0.1',
      port: requestedPort,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerError({
            category: 'listen_failed',
            message: 'Coordinator listener failed',
            cause,
          }),
      ),
    )
    if (server.address._tag !== 'TcpAddress') {
      return yield* new ServerError({
        category: 'listen_failed',
        message: 'Coordinator requires TCP',
      })
    }
    const port = server.address.port
    const authorities = new Set([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`])
    const app = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const host = request.headers['host'] ?? ''
      if (!authorities.has(host)) {
        return HttpServerResponse.empty({ status: 403 })
      }
      const origin = request.headers['origin']
      if (
        (origin !== undefined && origin !== `http://${host}`) ||
        request.headers['sec-fetch-site'] === 'cross-site'
      ) {
        return HttpServerResponse.empty({ status: 403 })
      }
      // No browser mutation endpoint exists. Reload is a local process signal, so no CSRF token is needed.
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return HttpServerResponse.empty({ status: 405, headers: { Allow: 'GET, HEAD' } })
      }
      const path = request.url.split('?')[0] ?? ''
      if (path === '/api/v1/registry') {
        return HttpServerResponse.unsafeJson(yield* registry.snapshot)
      }
      const asset = assets.get(path)
      return asset === undefined
        ? HttpServerResponse.empty({ status: 404 })
        : HttpServerResponse.uint8Array(asset.body, { contentType: asset.contentType })
    }).pipe(Effect.map(HttpServerResponse.setHeaders(headers)))
    yield* server.serve(app)
    return { port, url: `http://127.0.0.1:${String(port)}` }
  })
