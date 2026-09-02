// The handlers behind the endpoint definitions in `api/endpoints.ts`.
//
// Each one is written against the operator backend and answers with the document its endpoint
// declares, or fails with one of the refusals that endpoint declares. Nothing here builds a
// response: the status, the media type and the body's shape are the endpoint's statement, and the
// platform encodes what a handler returns through the schema the endpoint named. A handler that
// answered with a shape the contract does not describe is a failed response rather than a document
// a reader has to discover is wrong.

import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import * as HttpApiGroup from '@effect/platform/HttpApiGroup'
import * as HttpApp from '@effect/platform/HttpApp'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import { timingSafeEqual } from 'node:crypto'
import { Effect, Layer, Redacted, Schema } from 'effect'

import type { AgentDetailLookup } from '@sloppenheimer/core'

import { publishIssueDetail, publishRefresh, publishState } from './api.js'
import type { PublishedAgentDetail } from './api/agent-detail-schema.js'
import { issueNumberShape, operatorApi, type PublishedIssueAction } from './api/endpoints.js'
import {
  agentDetailUnavailable,
  agentNotActive,
  agentNotFound,
  agentSessionCompleted,
  backendError,
  invalidCsrfToken,
  issueNotFound,
  notFound,
  type OperatorApiError,
} from './api/errors.js'
import { PageToken, SubmittedPageToken } from './api/page-token.js'
import type { OperatorBackend, OperatorBackendError } from './operator.js'

/**
 * The page token, compared without leaking where two tokens first differ. A request that carried no
 * token arrives as an empty one and is refused on the same terms as one that carries the wrong
 * token.
 */
const tokenMatches = (submitted: string, expected: string): boolean => {
  const submittedBytes = Buffer.from(submitted)
  const expectedBytes = Buffer.from(expected)
  return (
    submittedBytes.length === expectedBytes.length && timingSafeEqual(submittedBytes, expectedBytes)
  )
}

/**
 * The token this request carried, judged against the one this process minted.
 *
 * The security scheme in `api/page-token.ts` decodes it and this compares it, rather than the
 * scheme refusing the request itself: a refusal in the middleware would come before everything else
 * an endpoint checks, and an issue number this API cannot address is a `404` whether or not a token
 * came with the request.
 */
const requirePageToken = (
  csrfToken: string,
): Effect.Effect<void, OperatorApiError<'invalid_csrf_token'>, SubmittedPageToken> =>
  Effect.flatMap(SubmittedPageToken, (submitted) =>
    tokenMatches(Redacted.value(submitted), csrfToken)
      ? Effect.void
      : Effect.fail(invalidCsrfToken.failure),
  )

/**
 * The issue number an eligibility change names, on the bound the console has always applied. A
 * spelling this API cannot address names no resource, so it is a `404` rather than a complaint
 * about the request — and the check runs before the page token is read, which is the order the
 * route has always answered in.
 */
const issueNumberSchema: Schema.Schema<number, string> = Schema.String.pipe(
  Schema.pattern(issueNumberShape),
  Schema.compose(Schema.NumberFromString),
)

const decodeIssueNumber = (value: string): Effect.Effect<number, OperatorApiError<'not_found'>> =>
  Schema.decode(issueNumberSchema)(value).pipe(Effect.mapError(() => notFound.failure))

/** Typed backend failures are sanitized: what went wrong is logged, never published. */
const runBackend = <Value>(
  operation: Effect.Effect<Value, OperatorBackendError>,
): Effect.Effect<Value, OperatorApiError<'backend_error'>> =>
  Effect.mapError(operation, () => backendError.failure)

const issueActionAccepted = (issueNumber: number, enabled: boolean): PublishedIssueAction => ({
  accepted: true,
  issueNumber,
  enabled,
})

const publishedAgentDetail = (detail: PublishedAgentDetail['detail']): PublishedAgentDetail => ({
  version: 'v1',
  detail,
})

/**
 * `Retry-After` on the one refusal that promises the answer is coming. The schema layer describes
 * bodies and statuses rather than headers, so the header is appended to whatever response this
 * request ends up sending — which is the refusal below it.
 */
const retryAfterSeconds = (seconds: number): Effect.Effect<void> =>
  HttpApp.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, 'Retry-After', String(seconds))),
  )

type AgentDetailFailure =
  | OperatorApiError<'agent_session_completed'>
  | OperatorApiError<'agent_not_active'>
  | OperatorApiError<'agent_detail_unavailable'>
  | OperatorApiError<'agent_not_found'>

/** The four outcomes the detail lookup distinguishes, as the answers they each deserve. */
const agentDetailAnswer = (
  lookup: AgentDetailLookup,
): Effect.Effect<PublishedAgentDetail, AgentDetailFailure> => {
  switch (lookup._tag) {
    case 'Found': {
      return Effect.succeed(publishedAgentDetail(lookup.detail))
    }
    case 'Completed': {
      return Effect.fail(agentSessionCompleted.failure)
    }
    case 'NoSession': {
      return Effect.fail(agentNotActive.failure)
    }
    case 'Unavailable': {
      return Effect.zipRight(
        retryAfterSeconds(1),
        Effect.fail(agentDetailUnavailable.withMessage(lookup.reason)),
      )
    }
    case 'Unknown': {
      return Effect.fail(agentNotFound.failure)
    }
  }
}

/**
 * The security scheme's implementation: what the request carried, handed on unjudged. The token is
 * decoded here and compared in {@link requirePageToken}, for the ordering reason recorded there.
 */
const pageTokenLayer: Layer.Layer<PageToken> = Layer.succeed(
  PageToken,
  PageToken.of({ pageToken: (submitted) => Effect.succeed(submitted) }),
)

/**
 * The endpoint group, bound to one backend and one page token.
 *
 * The token is minted per process rather than configured, so the handlers take it as an argument
 * instead of resolving a service: there is exactly one server and it holds exactly one token.
 */
export const operatorHandlers = (
  backend: OperatorBackend,
  csrfToken: string,
): Layer.Layer<HttpApiGroup.ApiGroup<'operator', 'operator'>> =>
  HttpApiBuilder.group(operatorApi, 'operator', (handlers) =>
    handlers
      .handle('state', () => Effect.map(backend.snapshot, publishState))
      .handle('backlog', () => runBackend(backend.backlog))
      .handle('refresh', () =>
        Effect.zipRight(requirePageToken(csrfToken), Effect.map(backend.refresh, publishRefresh)),
      )
      .handle('startIssue', ({ path }) =>
        Effect.gen(function* () {
          const issueNumber = yield* decodeIssueNumber(path.issueNumber)
          yield* requirePageToken(csrfToken)
          yield* runBackend(backend.setIssueEnabled(issueNumber, true))
          return issueActionAccepted(issueNumber, true)
        }),
      )
      .handle('pauseIssue', ({ path }) =>
        Effect.gen(function* () {
          const issueNumber = yield* decodeIssueNumber(path.issueNumber)
          yield* requirePageToken(csrfToken)
          yield* runBackend(backend.setIssueEnabled(issueNumber, false))
          return issueActionAccepted(issueNumber, false)
        }),
      )
      // The identifier is not matched against a shape: this route is what a published `detail_url`
      // points at, so a pattern here would make a tracker's own inspection resource unreachable
      // for the identifiers it spells. The lookup distinguishes the four outcomes, and an
      // identifier this session has never run is `agent_not_found` whether it is unknown or
      // unspellable.
      .handle('agentDetail', ({ path }) =>
        Effect.flatMap(backend.agentDetail(path.identifier), agentDetailAnswer),
      )
      .handle('issueResource', ({ path }) =>
        Effect.gen(function* () {
          const snapshot = yield* backend.snapshot
          const lookup = yield* backend.agentDetail(path.identifier)
          const detail = publishIssueDetail(path.identifier, snapshot, lookup)
          if (detail === null) {
            return yield* Effect.fail(issueNotFound.failure)
          }
          return detail
        }),
      ),
  ).pipe(Layer.provide(pageTokenLayer))
