// The operator HTTP API as one executable contract.
//
// Every versioned endpoint states its own path, method, parameters, success document and the
// refusals it may answer with, and nothing else describes them: the handlers in
// `src/operator/handlers.ts` are written against these definitions, the responses are encoded
// through the same schemas before they are sent, the 404 and 405 the server answers for a URI no
// endpoint claims are derived from {@link operatorRoutes}, and the OpenAPI document is generated
// from the whole of it.
//
// The paths are spelled in full rather than assembled from a prefix. What an identifier collides
// with is the path a route ends up registered at, and the reserved-identifier guard in
// `test/operator/server.test.ts` reads these definitions to check the set has not grown, so the
// definitions are the honest place for a reader to see the namespace whole.

import * as HttpApi from '@effect/platform/HttpApi'
import * as HttpApiEndpoint from '@effect/platform/HttpApiEndpoint'
import * as HttpApiGroup from '@effect/platform/HttpApiGroup'
import * as OpenApi from '@effect/platform/OpenApi'
import { Schema } from 'effect'

import { isJsonObject, type JsonObject, type JsonValue } from '@sloppenheimer/core/support/json.js'

import { publishedAgentDetailSchema } from './agent-detail-schema.js'
import { backlogSnapshotSchema } from './backlog-schema.js'
import {
  agentDetailUnavailable,
  agentNotActive,
  agentNotFound,
  agentSessionCompleted,
  backendError,
  invalidCsrfToken,
  issueNotFound,
  notFound,
} from './errors.js'
import { publishedIssueDetailSchema } from './issue-schema.js'
import { PageToken } from './page-token.js'
import { jsonDocument } from './media.js'
import { publishedRefreshSchema, publishedStateSchema } from './state-schema.js'

/** The acknowledgement an eligibility change returns, in the console's own vocabulary. */
export type PublishedIssueAction = Readonly<{
  accepted: true
  issueNumber: number
  enabled: boolean
}>

const publishedIssueActionSchema: Schema.Schema<PublishedIssueAction> = Schema.Struct({
  accepted: Schema.Literal(true),
  issueNumber: Schema.Number,
  enabled: Schema.Boolean,
})

/**
 * The path parameter both single-resource endpoints take. It is not matched against a shape:
 * `IssueIdentifier` is an unconstrained branded string and a tracker is free to spell one `GH-7`,
 * so a pattern here would decide on GitHub's behalf which providers may reach a SPEC resource.
 */
const identifierPath = Schema.Struct({ identifier: Schema.String })

/**
 * The issue number an eligibility change names. It is read as a string here and decoded against
 * {@link issueNumberShape} in the handler, because a number this API cannot address is a resource
 * that does not exist — a `404` — rather than a malformed request.
 */
const issueNumberPath = Schema.Struct({ issueNumber: Schema.String })

/** The shape an issue number takes in a path: digits, and nothing else. */
export const issueNumberShape = /^\d+$/u

/**
 * The shape a path parameter must have for its path to name a resource at all.
 *
 * A parameter absent from here is unconstrained, which is the default and what
 * {@link identifierPath} relies on. `issueNumber` is not like that: the console's eligibility
 * controls name an issue by number, and a spelling this API cannot address names no resource on
 * any method. Stating that here rather than in the handler alone is what keeps
 * `GET /api/v1/issues/not-a-number/start` a `404` — the same answer the route has always given —
 * rather than a `405` advertising the POST of a resource that does not exist. The server reads
 * this to decide whether a URI is claimed at all, and the handler decodes the parameter against
 * the same shape.
 */
export const pathParameterShapes: ReadonlyMap<string, RegExp> = new Map([
  ['issueNumber', issueNumberShape],
])

/**
 * This API never answers `400`.
 *
 * The platform documents a decode failure on every operation, because an endpoint may in general
 * have a request to decode. None of these do: no body, no query parameters, and a path parameter
 * that is an unconstrained string, so nothing a caller sends can fail to decode. What the platform
 * would report that way is a *response* that failed the schema its own endpoint declared, and the
 * server publishes the sanitized internal error in its place rather than the parse detail. Dropping
 * the status keeps the description to what a reader will actually be answered with.
 */
const withoutDecodeFailure = (operation: JsonValue): unknown => {
  if (!isJsonObject(operation)) {
    return operation
  }
  const responses = operation['responses']
  if (!isJsonObject(responses)) {
    return operation
  }
  return {
    ...operation,
    responses: Object.fromEntries(Object.entries(responses).filter(([status]) => status !== '400')),
  }
}

const mapValues = (
  record: JsonObject,
  transform: (value: JsonValue) => unknown,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, transform(value)]))

/** The generated description, with the status no operation answers removed from every one of them. */
const describedResponses = (specification: Record<string, unknown>): Record<string, unknown> => {
  const paths = specification['paths']
  if (!isJsonObject(paths)) {
    return specification
  }
  return {
    ...specification,
    paths: mapValues(paths, (item) =>
      isJsonObject(item) ? mapValues(item, withoutDecodeFailure) : item,
    ),
  }
}

// The snapshot the state and per-issue resources read is held in memory and cannot fail, so
// neither endpoint declares the backend refusal its neighbours below do. If that read ever acquires
// a failure channel, the handler stops typechecking until this contract says so.
const state = HttpApiEndpoint.get('state', '/api/v1/state')
  .addSuccess(jsonDocument(publishedStateSchema), { status: 200 })
  .annotate(OpenApi.Description, 'The baseline runtime state document SPEC 13.7.2 names.')

const backlog = HttpApiEndpoint.get('backlog', '/api/v1/backlog')
  .addSuccess(jsonDocument(backlogSnapshotSchema), { status: 200 })
  .addError(backendError.schema, { status: backendError.status })
  .annotate(
    OpenApi.Description,
    "The open backlog and its dependency graph, in the console's own vocabulary.",
  )

const refresh = HttpApiEndpoint.post('refresh', '/api/v1/refresh')
  .middleware(PageToken)
  .addSuccess(jsonDocument(publishedRefreshSchema), { status: 202 })
  .addError(invalidCsrfToken.schema, { status: invalidCsrfToken.status })
  .annotate(
    OpenApi.Description,
    'Requests a poll pass and answers once the pass the request joined has finished.',
  )

const startIssue = HttpApiEndpoint.post('startIssue', '/api/v1/issues/:issueNumber/start')
  .middleware(PageToken)
  .setPath(issueNumberPath)
  .addSuccess(jsonDocument(publishedIssueActionSchema), { status: 202 })
  .addError(notFound.schema, { status: notFound.status })
  .addError(invalidCsrfToken.schema, { status: invalidCsrfToken.status })
  .addError(backendError.schema, { status: backendError.status })
  .annotate(OpenApi.Description, "Puts an issue back in the host's hands.")

const pauseIssue = HttpApiEndpoint.post('pauseIssue', '/api/v1/issues/:issueNumber/pause')
  .middleware(PageToken)
  .setPath(issueNumberPath)
  .addSuccess(jsonDocument(publishedIssueActionSchema), { status: 202 })
  .addError(notFound.schema, { status: notFound.status })
  .addError(invalidCsrfToken.schema, { status: invalidCsrfToken.status })
  .addError(backendError.schema, { status: backendError.status })
  .annotate(OpenApi.Description, 'Holds an issue back from dispatch.')

const agentDetail = HttpApiEndpoint.get('agentDetail', '/api/v1/agents/:identifier')
  .setPath(identifierPath)
  .addSuccess(jsonDocument(publishedAgentDetailSchema), { status: 200 })
  .addError(agentNotActive.schema, { status: agentNotActive.status })
  .addError(agentSessionCompleted.schema, { status: agentSessionCompleted.status })
  .addError(agentDetailUnavailable.schema, { status: agentDetailUnavailable.status })
  .addError(agentNotFound.schema, { status: agentNotFound.status })
  .annotate(
    OpenApi.Description,
    "The live, typed detail for one agent session. This is what a running or retrying row's `detail_url` points at.",
  )

const issueResource = HttpApiEndpoint.get('issueResource', '/api/v1/:identifier')
  .setPath(identifierPath)
  .addSuccess(jsonDocument(publishedIssueDetailSchema), { status: 200 })
  .addError(issueNotFound.schema, { status: issueNotFound.status })
  .annotate(
    OpenApi.Description,
    'The per-issue baseline SPEC 13.7.2 documents beside the state resource.',
  )

/**
 * The versioned endpoints, in the order a reader meets them. Registration order does not decide
 * which one answers a request — the router prefers a fixed segment to a parameter of its own
 * accord — so the wildcard resource sits last because that is where it belongs in the reading,
 * not to win a race.
 */
const operatorGroup = HttpApiGroup.make('operator')
  .add(state)
  .add(backlog)
  .add(refresh)
  .add(startIssue)
  .add(pauseIssue)
  .add(agentDetail)
  .add(issueResource)
  .annotate(OpenApi.Title, 'Sloppenheimer operator API')

export const operatorApi = HttpApi.make('operator')
  .add(operatorGroup)
  .annotate(OpenApi.Title, 'Sloppenheimer operator API')
  .annotate(
    OpenApi.Description,
    'The versioned HTTP surface a Sloppenheimer host serves on loopback for its operator console.',
  )
  .annotate(OpenApi.Version, 'v1')
  .annotate(OpenApi.Transform, describedResponses)

/**
 * One registration: the method and path it answers on. The path keeps the router's own shape, so a
 * route read from here can be registered again — which is how the server asks the matcher what a
 * URI serves rather than reading the paths itself.
 */
export type OperatorRoute = Readonly<{ method: string; path: `/${string}` }>

/**
 * The registrations themselves, read from the definitions rather than restated beside them. The
 * server decides `404` against `405` from this list, and the reserved-identifier guard reads it to
 * check which names the per-issue resource can no longer be addressed by.
 */
export const operatorRoutes: readonly OperatorRoute[] = Object.values(operatorApi.groups).flatMap(
  (group) =>
    Object.values(group.endpoints).map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
    })),
)
