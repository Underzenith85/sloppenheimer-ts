import { expect, it } from '@effect/vitest'
import { request as outgoingRequest } from 'node:http'
import { Effect } from 'effect'
import { startCoordinatorServer } from '../../packages/coordinator/src/server.js'
import { registryLayer } from '../../packages/coordinator/src/registry.js'

it.live('serves the registry and static bytes with an independent browser boundary', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startCoordinatorServer(
        0,
        new Map([
          [
            '/',
            {
              body: new TextEncoder().encode('<html>Coordinator</html>'),
              contentType: 'text/html',
            },
          ],
          [
            '/assets/app.js',
            { body: new TextEncoder().encode('export {}'), contentType: 'text/javascript' },
          ],
        ]),
      )
      const request = (path: string, options?: RequestInit): Effect.Effect<Response, unknown> =>
        Effect.tryPromise(() => fetch(`${server.url}${path}`, options))
      const hostStatus = (host: string): Effect.Effect<number, unknown> =>
        Effect.tryPromise(
          () =>
            new Promise<number>((resolve, reject) => {
              const outgoing = outgoingRequest(
                server.url,
                { headers: { Host: host } },
                (response) => {
                  response.resume()
                  resolve(response.statusCode ?? 0)
                },
              )
              outgoing.once('error', reject)
              outgoing.end()
            }),
        )
      const response = yield* request('/api/v1/registry')
      expect(response.status).toBe(200)
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({
        status: 'empty_registry',
        generation: 1,
        instances: [],
      })
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
      expect((yield* request('/')).headers.get('content-type')).toContain('text/html')
      expect((yield* request('/assets/app.js')).status).toBe(200)
      expect((yield* request('/assets/unknown.js')).status).toBe(404)
      expect((yield* request('/api/v1/registry', { method: 'POST' })).status).toBe(405)
      expect(yield* hostStatus('evil.example')).toBe(403)
      expect((yield* request('/', { headers: { Origin: 'https://evil.example' } })).status).toBe(
        403,
      )
      expect((yield* request('/', { headers: { Origin: server.url } })).status).toBe(200)
      expect((yield* request('/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(
        403,
      )
      expect(yield* hostStatus('localhost:1')).toBe(403)
      expect((yield* request('/assets/%2e%2e/config.ts')).status).toBe(404)
      const head = yield* request('/', { method: 'HEAD' })
      expect(yield* Effect.tryPromise(() => head.text())).toBe('')
    }),
  ).pipe(Effect.provide(registryLayer({ instances: [] }))),
)
