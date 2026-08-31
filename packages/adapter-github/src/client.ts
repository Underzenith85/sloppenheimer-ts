import * as FetchHttpClient from '@effect/platform/FetchHttpClient'
import * as PlatformHeaders from '@effect/platform/Headers'
import * as HttpBody from '@effect/platform/HttpBody'
import * as HttpClient from '@effect/platform/HttpClient'
import type * as HttpClientError from '@effect/platform/HttpClientError'
import * as HttpClientRequest from '@effect/platform/HttpClientRequest'
import type * as HttpMethod from '@effect/platform/HttpMethod'
import { Clock, Effect, Either, Layer, Option, Redacted, Schema } from 'effect'

import type { JsonValue } from '@symphony/core/domain/domain.js'
import { TrackerError } from '@symphony/core/domain/errors.js'
import { isJsonValue } from '@symphony/core/support/json.js'
import type { GitHubProviderConfig } from './provider.js'

export const githubApiVersion = '2026-03-10'
export const githubRequestTimeoutMs = 30_000
export const githubUserAgent = 'symphony-ts/0.1'
/** GitHub's maximum page size for list endpoints. */
export const githubPageSize = 100
/** Bounded pagination: a scoped list that never terminates is a pagination integrity failure. */
export const githubMaxPages = 100

/** GitHub-boundary aliases retained for readability in issue and pull-request parsing. */
export type { JsonObject as JsonRecord } from '@symphony/core/domain/domain.js'
export { isJsonObject as isJsonRecord } from '@symphony/core/support/json.js'

export const trackerResponseError = (message: string, cause?: unknown): TrackerError =>
  new TrackerError({
    category: 'tracker_response',
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  })

export const trackerPaginationError = (message: string, cause?: unknown): TrackerError =>
  new TrackerError({
    category: 'tracker_pagination',
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  })

/**
 * Maps whatever went wrong onto a `TrackerError`, leaving one that already is alone.
 *
 * A GitHub read is a stack of steps that each report failure their own way: a schema rejects a
 * payload with a `ParseError`, `new URL` throws a `TypeError`, and a decoder called from inside
 * `Effect.try` throws a `TrackerError` that has already said something more precise than its
 * caller could. Re-wrapping that last one would bury the message the reader wants, so it passes
 * through and only an unrecognized cause is described by the caller's `message`.
 *
 * `wrap` names which failure this is: a payload Symphony could not read, or a page sequence it
 * could not follow.
 */
export const trackerCause =
  (
    message: string,
    wrap: (message: string, cause?: unknown) => TrackerError = trackerResponseError,
  ): ((cause: unknown) => TrackerError) =>
  (cause: unknown): TrackerError =>
    cause instanceof TrackerError ? cause : wrap(message, cause)

/**
 * Decodes with a schema, reporting a rejected payload through `onFailure`.
 *
 * Every GitHub payload this adapter reads arrives as `unknown` and leaves as a checked value or a
 * `TrackerError`; only the message differs. `onFailure` is a parameter rather than a message so
 * that a field which reports the key it was read under can share this with a whole-record decode
 * that reports only what it expected.
 */
export const decodeTracker = <Value, Encoded>(
  schema: Schema.Schema<Value, Encoded>,
  value: unknown,
  onFailure: (cause: unknown) => TrackerError,
): Effect.Effect<Value, TrackerError> =>
  Schema.decodeUnknown(schema)(value).pipe(Effect.mapError(onFailure))

/**
 * {@link decodeTracker} for a caller already inside `Effect.try`, which reports by throwing.
 *
 * The throw is caught by the surrounding `Effect.try` and mapped back onto the failure channel, so
 * a `TrackerError` never escapes as a defect.
 */
export const decodeTrackerOrThrow = <Value, Encoded>(
  schema: Schema.Schema<Value, Encoded>,
  value: unknown,
  onFailure: (cause: unknown) => TrackerError,
): Value =>
  Either.match(Schema.decodeUnknownEither(schema)(value), {
    onLeft: (cause) => {
      throw onFailure(cause)
    },
    onRight: (decoded) => decoded,
  })

/** Transport failures — connection, DNS, TLS, an aborted read, or the request deadline. */
const trackerRequestError = (cause: unknown): TrackerError =>
  new TrackerError({
    category: 'tracker_request',
    message: 'GitHub request failed',
    retryable: true,
    cause,
  })

const header = (headers: PlatformHeaders.Headers, name: string): string | null =>
  Option.getOrNull(PlatformHeaders.get(headers, name))

const parseRetryAfterMs = (value: string | null, now: number): number | null => {
  if (value === null) {
    return null
  }
  const trimmed = value.trim()
  if (/^\d+$/u.test(trimmed)) {
    return Number(trimmed) * 1_000
  }
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) {
    return null
  }
  return Math.max(date - now, 0)
}

const parseRateLimitResetMs = (value: string | null, now: number): number | null => {
  if (value === null || !/^\d+$/u.test(value.trim())) {
    return null
  }
  return Math.max(Number(value.trim()) * 1_000 - now, 0)
}

/**
 * Maps GitHub's primary (`403` with an exhausted `x-ratelimit-remaining`) and secondary (`429`, or
 * `403` with `Retry-After`) rate-limit responses onto a single retryable category, preserving the
 * advertised delay as retry metadata when GitHub supplies one.
 */
export const rateLimitError = (
  headers: PlatformHeaders.Headers,
  status: number,
  now: number,
): TrackerError | null => {
  const retryAfterMs = parseRetryAfterMs(header(headers, 'retry-after'), now)
  const remaining = header(headers, 'x-ratelimit-remaining')
  const exhausted = remaining !== null && /^0+$/u.test(remaining.trim())
  const limited = status === 429 || (status === 403 && (retryAfterMs !== null || exhausted))
  if (!limited) {
    return null
  }
  const resetMs = parseRateLimitResetMs(header(headers, 'x-ratelimit-reset'), now)
  const delayMs = retryAfterMs ?? resetMs
  return new TrackerError({
    category: 'tracker_rate_limited',
    message: `GitHub rate limit exceeded (HTTP ${String(status)})`,
    retryable: true,
    ...(delayMs === null ? {} : { retryAfterMs: delayMs }),
  })
}

export const statusError = (status: number): TrackerError =>
  new TrackerError({
    category: 'tracker_status',
    message: `GitHub returned HTTP ${String(status)}`,
    retryable: status >= 500 || status === 408 || status === 409,
  })

export type GitHubHttpResult = Readonly<{
  status: number
  /** `null` for an accepted non-success status or an empty body. */
  body: JsonValue | null
  linkHeader: string | null
}>

export type GitHubRequestInit = Readonly<{
  method?: HttpMethod.HttpMethod
  /** An already-serialized JSON payload; the transport supplies its `Content-Type`. */
  body?: string
}>

/**
 * The client the transport uses when the caller has not provided one. The composition root and the
 * adapter tests bind `HttpClient` through a layer; this is the standalone default.
 */
export const githubHttpClientLayer: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer

/**
 * Runs a request against the `HttpClient` in context, falling back to `githubHttpClientLayer`.
 *
 * The client is read as an optional service rather than left in the requirement channel because
 * the adapter satisfies ports whose operations are `R = never`, and `executeTool` leaves Effect
 * entirely for a promise. Reading it here keeps the client injectable through a layer at every
 * call site without asking the ports to carry the requirement.
 */
const withGitHubHttpClient = <Value, Failure>(
  effect: Effect.Effect<Value, Failure, HttpClient.HttpClient>,
): Effect.Effect<Value, Failure> =>
  Effect.flatMap(Effect.serviceOption(HttpClient.HttpClient), (provided) =>
    Option.isSome(provided)
      ? Effect.provideService(effect, HttpClient.HttpClient, provided.value)
      : Effect.provide(effect, githubHttpClientLayer),
  )

/**
 * Binds one constructed adapter to a client, for every operation it exposes.
 *
 * An operation that stays in Effect can read a client from its caller's context, but `executeTool`
 * leaves Effect for a promise and has no context to read, so an adapter that must talk through a
 * particular client has to carry it from construction. A client bound here is the more specific
 * binding of the two and takes precedence for that adapter's operations.
 */
export const withBoundHttpClient =
  (client: HttpClient.HttpClient | undefined) =>
  <Value, Failure>(effect: Effect.Effect<Value, Failure>): Effect.Effect<Value, Failure> =>
    client === undefined ? effect : Effect.provideService(effect, HttpClient.HttpClient, client)

const githubRequest = (
  provider: GitHubProviderConfig,
  url: string,
  init: GitHubRequestInit | undefined,
): HttpClientRequest.HttpClientRequest => {
  const request = HttpClientRequest.make(init?.method ?? 'GET')(url).pipe(
    HttpClientRequest.setHeaders({
      Accept: 'application/vnd.github+json',
      // The one place the credential is unwrapped: the header it authenticates.
      Authorization: `Bearer ${Redacted.value(provider.token)}`,
      'User-Agent': githubUserAgent,
      'X-GitHub-Api-Version': githubApiVersion,
    }),
  )
  if (init?.body === undefined) {
    return request
  }
  return HttpClientRequest.setBody(
    request,
    HttpBody.raw(init.body, { contentType: 'application/json' }),
  )
}

/**
 * Single GitHub transport. Every request maps transport failures, rate limits, non-success statuses
 * and malformed payloads onto stable `TrackerError` categories.
 *
 * `acceptedStatuses` names non-success statuses the caller handles itself (for example `404` for a
 * branch existence probe); their bodies are not decoded.
 */
export const githubJson = (
  provider: GitHubProviderConfig,
  url: string,
  init?: GitHubRequestInit,
  acceptedStatuses: readonly number[] = [],
): Effect.Effect<GitHubHttpResult, TrackerError> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(githubRequest(provider, url, init))
      .pipe(Effect.mapError((cause: HttpClientError.HttpClientError) => trackerRequestError(cause)))
    const linkHeader = header(response.headers, 'link')
    // The advertised delay is relative to when the response was read, so the instant comes from
    // the same clock the retry schedule is measured against.
    const limited = rateLimitError(
      response.headers,
      response.status,
      yield* Clock.currentTimeMillis,
    )
    if (limited !== null) {
      return yield* Effect.fail(limited)
    }
    if (acceptedStatuses.includes(response.status)) {
      return { status: response.status, body: null, linkHeader }
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(statusError(response.status))
    }
    if (response.status === 204) {
      return { status: response.status, body: null, linkHeader }
    }
    const body = yield* response.json.pipe(
      Effect.mapError((cause: HttpClientError.ResponseError) =>
        trackerResponseError('GitHub returned a malformed JSON payload', cause),
      ),
    )
    if (!isJsonValue(body)) {
      return yield* Effect.fail(trackerResponseError('GitHub returned non-JSON data'))
    }
    return { status: response.status, body, linkHeader }
  }).pipe(
    Effect.timeoutFail({
      duration: githubRequestTimeoutMs,
      onTimeout: () =>
        trackerRequestError(
          new Error(`GitHub request exceeded ${String(githubRequestTimeoutMs)}ms`),
        ),
    }),
    withGitHubHttpClient,
  )

/** Reads the `rel="next"` target from a `Link` header, rejecting cross-origin or malformed links. */
export const parseNextUrl = (
  linkHeader: string | null,
  requestUrl: string,
  apiBaseUrl: string,
): string | null => {
  if (linkHeader === null) {
    return null
  }
  for (const entry of linkHeader.split(',')) {
    const [target, ...parameters] = entry.trim().split(';')
    const relations = parameters.flatMap((parameter) => {
      const match = /^\s*rel\s*=\s*"([^"]*)"\s*$/iu.exec(parameter)
      return match?.[1]?.split(/\s+/u) ?? []
    })
    if (!relations.includes('next')) {
      continue
    }
    const targetMatch = /^<([^<>]+)>$/u.exec(target ?? '')
    if (targetMatch?.[1] === undefined) {
      throw trackerPaginationError('GitHub returned an invalid next page link')
    }
    try {
      const nextUrl = new URL(targetMatch[1], requestUrl)
      if (nextUrl.origin !== new URL(apiBaseUrl).origin) {
        throw trackerPaginationError('GitHub next page URL has an unexpected origin')
      }
      return nextUrl.href
    } catch (cause: unknown) {
      throw trackerCause('GitHub returned an invalid next page URL', trackerPaginationError)(cause)
    }
  }
  return null
}
