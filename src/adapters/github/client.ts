import { Effect } from 'effect'

import type { JsonValue } from '../../domain/domain.js'
import { TrackerError } from '../../errors.js'
import { isJsonValue } from '../../support/json.js'
import type { GitHubProviderConfig } from './provider.js'

export const githubApiVersion = '2026-03-10'
export const githubRequestTimeoutMs = 30_000
export const githubUserAgent = 'symphony-ts/0.1'
/** GitHub's maximum page size for list endpoints. */
export const githubPageSize = 100
/** Bounded pagination: a scoped list that never terminates is a pagination integrity failure. */
export const githubMaxPages = 100

/** GitHub-boundary aliases retained for readability in issue and pull-request parsing. */
export type { JsonObject as JsonRecord } from '../../domain/domain.js'
export { isJsonObject as isJsonRecord } from '../../support/json.js'

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
  headers: Headers,
  status: number,
  now = Date.now(),
): TrackerError | null => {
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'), now)
  const remaining = headers.get('x-ratelimit-remaining')
  const exhausted = remaining !== null && /^0+$/u.test(remaining.trim())
  const limited = status === 429 || (status === 403 && (retryAfterMs !== null || exhausted))
  if (!limited) {
    return null
  }
  const resetMs = parseRateLimitResetMs(headers.get('x-ratelimit-reset'), now)
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

const githubHeaders = (provider: GitHubProviderConfig, init: RequestInit | undefined): Headers => {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/vnd.github+json')
  headers.set('Authorization', `Bearer ${provider.token}`)
  headers.set('User-Agent', githubUserAgent)
  headers.set('X-GitHub-Api-Version', githubApiVersion)
  if (init?.body !== undefined && init.body !== null) {
    headers.set('Content-Type', 'application/json')
  }
  return headers
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
  init?: RequestInit,
  acceptedStatuses: readonly number[] = [],
): Effect.Effect<GitHubHttpResult, TrackerError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        ...init,
        headers: githubHeaders(provider, init),
        signal: AbortSignal.timeout(githubRequestTimeoutMs),
      })
      const limited = rateLimitError(response.headers, response.status)
      if (limited !== null) {
        throw limited
      }
      if (acceptedStatuses.includes(response.status)) {
        return { status: response.status, body: null, linkHeader: response.headers.get('link') }
      }
      if (!response.ok) {
        throw statusError(response.status)
      }
      if (response.status === 204) {
        return { status: response.status, body: null, linkHeader: response.headers.get('link') }
      }
      let body: unknown
      try {
        body = await response.json()
      } catch (cause: unknown) {
        throw trackerResponseError('GitHub returned a malformed JSON payload', cause)
      }
      if (!isJsonValue(body)) {
        throw trackerResponseError('GitHub returned non-JSON data')
      }
      return { status: response.status, body, linkHeader: response.headers.get('link') }
    },
    catch: (cause: unknown) =>
      cause instanceof TrackerError
        ? cause
        : new TrackerError({
            category: 'tracker_request',
            message: 'GitHub request failed',
            retryable: true,
            cause,
          }),
  })

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
      if (cause instanceof TrackerError) {
        throw cause
      }
      throw trackerPaginationError('GitHub returned an invalid next page URL', cause)
    }
  }
  return null
}
