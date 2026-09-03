// The OpenAPI document, generated from the endpoint definitions rather than written beside them.
//
// Every path, method, parameter, status and document shape in it comes from `api/endpoints.js`, so
// the description a consumer reads cannot describe a surface the server does not serve. The server
// publishes it at `/openapi.json`, outside the versioned namespace: a document served under
// `/api/v1/` would shadow an issue identifier spelled the same way, and the namespace reserves
// exactly two names today.

import * as OpenApi from '@effect/platform/OpenApi'

import { operatorApi } from './api/endpoints.js'

export const operatorOpenApiDocument = (): OpenApi.OpenAPISpec => OpenApi.fromApi(operatorApi)
