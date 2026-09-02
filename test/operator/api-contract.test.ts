import { Either, Schema } from 'effect'
import { isJsonArray, isJsonObject } from '@sloppenheimer/core/support/json.js'
import { describe, expect, it } from 'vitest'

import { operatorRoutes } from '../../src/operator/api/endpoints.js'
import { pageTokenHeader } from '../../src/operator/api/page-token.js'
import { publishedStateSchema } from '../../src/operator/api/state-schema.js'
import { operatorOpenApiDocument } from '../../src/operator/openapi.js'

/** The OpenAPI spelling of a route path: `:identifier` is `{identifier}` in the document. */
const documented = (path: string): string => path.replace(/:([^/]+)/gu, '{$1}')

/** Whether one operation in the description requires a security scheme to be satisfied. */
const isSecured = (operation: unknown): boolean =>
  isJsonObject(operation) && isJsonArray(operation['security']) && operation['security'].length > 0

describe('operator API contract', (): void => {
  /*
   * The description is generated from the endpoint definitions rather than written beside them, so
   * what it covers is exactly what the server serves. Deriving the expectation from the same
   * definitions is the point: an endpoint added without a document, or documented without being
   * served, is the failure this pins.
   */
  it('describes every declared route, and only those', (): void => {
    const document = operatorOpenApiDocument()

    expect(Object.keys(document.paths).sort()).toEqual(
      [...new Set(operatorRoutes.map((route) => documented(route.path)))].sort(),
    )
    for (const route of operatorRoutes) {
      const operations = document.paths[documented(route.path)] ?? {}
      expect(Object.keys(operations)).toContain(route.method.toLowerCase())
    }
  })

  it('describes the statuses and the media type each endpoint answers with', (): void => {
    const document = operatorOpenApiDocument()
    const state = document.paths['/api/v1/state']?.get?.responses ?? {}
    const refresh = document.paths['/api/v1/refresh']?.post?.responses ?? {}
    const agents = document.paths['/api/v1/agents/{identifier}']?.get?.responses ?? {}

    expect(Object.keys(state)).toEqual(['200'])
    expect(state['200']?.content).toHaveProperty(['application/json; charset=utf-8'])
    // The acknowledgement is a 202, and the page token is the only way to be refused.
    expect(Object.keys(refresh).sort()).toEqual(['202', '403'])
    // The four outcomes the detail lookup distinguishes, each with its own status.
    expect(Object.keys(agents).sort()).toEqual(['200', '404', '409', '410', '503'])
  })

  /*
   * The page token is a refusal a caller has to be able to anticipate, so it belongs in the
   * contract rather than in prose beside it. Declaring it as a security scheme is what puts the
   * header in the description and marks the operations that require it — every mutation, and only
   * those, since a read spends no tracker quota and dispatches no agent.
   */
  it('declares the page token as a security scheme on every mutation, and only those', (): void => {
    const document = operatorOpenApiDocument()
    const secured = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item).flatMap(([method, operation]) =>
        isSecured(operation) ? [`${method.toUpperCase()} ${path}`] : [],
      ),
    )

    expect(document.components?.securitySchemes?.['pageToken']).toEqual({
      type: 'apiKey',
      name: pageTokenHeader,
      in: 'header',
    })
    expect(secured.sort()).toEqual(
      operatorRoutes
        .filter((route) => route.method === 'POST')
        .map((route) => `POST ${documented(route.path)}`)
        .sort(),
    )
  })

  /*
   * The schemas are the runtime half of the published types, so a document that does not match one
   * is refused rather than sent. The server's own cases cover the documents it does publish; this
   * pins that the contract would in fact reject one it does not describe.
   */
  it('refuses a state document that does not match the published contract', (): void => {
    const missingEverything = Schema.encodeUnknownEither(publishedStateSchema)({})
    const wronglyTyped = Schema.encodeUnknownEither(publishedStateSchema)({
      generated_at: 1,
      workflow_path: '/tmp/WORKFLOW.md',
    })

    expect(Either.isLeft(missingEverything)).toBe(true)
    expect(Either.isLeft(wronglyTyped)).toBe(true)
  })
})
