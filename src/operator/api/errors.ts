// The error envelope this API publishes, as one executable statement per failure.
//
// Every refusal the operator server sends is `{ version, error: { code, message } }` with a status
// the code implies. That pairing used to live in the server as a call to a response helper; here it
// is a value carrying its own schema, so the endpoint definitions advertise the same statuses the
// handlers fail with, and both the API's own refusals and the ones raised outside it — an
// unmatched route, a method the URI does not answer, a non-loopback `Host`, an unexpected defect —
// are encoded through the schema before they are sent.
//
// The `code` is a literal in each schema rather than a plain string. That is what lets the platform
// pick the right member when it encodes a failure: the bodies are otherwise identical, and a union
// of open strings could only ever answer with the first status in it.

import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import { Effect, Schema } from 'effect'

import { jsonContentType, jsonDocument } from './media.js'

export type OperatorApiError<Code extends string> = Readonly<{
  version: 'v1'
  error: Readonly<{ code: Code; message: string }>
}>

/**
 * One refusal: the status it is sent with, the schema it is checked against, the body it sends by
 * default, and — for the two that report what the runtime observed — a body carrying another
 * message under the same code.
 */
export type OperatorApiFailure<Code extends string> = Readonly<{
  status: number
  schema: Schema.Schema<OperatorApiError<Code>>
  failure: OperatorApiError<Code>
  withMessage: (message: string) => OperatorApiError<Code>
}>

const apiFailure = <Code extends string>(
  code: Code,
  status: number,
  message: string,
): OperatorApiFailure<Code> => {
  const withMessage = (text: string): OperatorApiError<Code> => ({
    version: 'v1',
    error: { code, message: text },
  })
  return {
    status,
    schema: jsonDocument(
      Schema.Struct({
        version: Schema.Literal('v1'),
        error: Schema.Struct({ code: Schema.Literal(code), message: Schema.String }),
      }),
    ),
    failure: withMessage(message),
    withMessage,
  }
}

export const backendError = apiFailure(
  'backend_error',
  502,
  'The operator backend could not complete the request',
)

export const notFound = apiFailure('not_found', 404, 'The requested endpoint does not exist')

export const methodNotAllowed = apiFailure('method_not_allowed', 405, 'Use GET for this endpoint')

export const invalidCsrfToken = apiFailure(
  'invalid_csrf_token',
  403,
  'The request token is missing or invalid',
)

export const invalidHost = apiFailure(
  'invalid_host',
  421,
  'The operator console only accepts loopback hosts',
)

export const internalError = apiFailure('internal_error', 500, 'The request could not be completed')

/**
 * SPEC 13.7.2 reserves this for an issue unknown to the current in-memory state. Everything the
 * runtime still knows resolves instead, including work that has moved on to the pull-request
 * handoff lifecycle.
 */
export const issueNotFound = apiFailure(
  'issue_not_found',
  404,
  'That identifier is not known to this host',
)

export const agentSessionCompleted = apiFailure(
  'agent_session_completed',
  410,
  'The agent session has completed and its detail is no longer retained',
)

export const agentNotActive = apiFailure(
  'agent_not_active',
  409,
  'The issue has no active or retrying agent session',
)

export const agentDetailUnavailable = apiFailure(
  'agent_detail_unavailable',
  503,
  'The agent detail is not available yet',
)

export const agentNotFound = apiFailure(
  'agent_not_found',
  404,
  'No agent has run for that identifier in this session',
)

/**
 * A refusal raised outside the endpoint group, sent as the response it describes.
 *
 * The platform encodes the failures the API itself declares; these are the ones no endpoint owns,
 * so they are encoded here through the same schema rather than serialized straight to the socket. A
 * body that does not match the schema it was declared with is this module's own bug, and dies as
 * one.
 */
export const failureResponse = <Code extends string>(
  failure: OperatorApiFailure<Code>,
  body: OperatorApiError<Code>,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Schema.encode(failure.schema)(body).pipe(
    Effect.map((encoded) =>
      HttpServerResponse.unsafeJson(encoded, {
        status: failure.status,
        contentType: jsonContentType,
      }),
    ),
    Effect.orDie,
  )
