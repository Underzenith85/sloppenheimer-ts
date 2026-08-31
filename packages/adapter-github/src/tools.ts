import type * as HttpClient from '@effect/platform/HttpClient'
import { Effect } from 'effect'

import type { JsonObject, JsonValue } from '@symphony/core/domain/domain.js'
import { TrackerError } from '@symphony/core/domain/errors.js'
import type { GitHubProviderConfig } from './provider.js'
import type {
  HostToolContext,
  HostToolFailureCode,
  HostToolResult,
} from '@symphony/core/domain/host-tools.js'
import { isJsonRecord, trackerResponseError, withBoundHttpClient } from './client.js'

/*
 * Host-tool plumbing shared by the tracker's issue tools and the code-review capability's
 * pull-request tools: argument validation, session-scope checks, and the mapping from a
 * `TrackerError` back onto the JSON-safe failure vocabulary the host boundary promises.
 */

export const toolFailure = (
  code: HostToolFailureCode,
  message: string,
  retryable = false,
  retryAfterMs?: number,
): HostToolResult => ({
  success: false,
  error: { code, message, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
})

export const invalidToolArguments = (message: string): HostToolResult =>
  toolFailure('invalid_arguments', message)

export const exactObject = (
  value: JsonValue,
  allowedKeys: ReadonlySet<string>,
): JsonObject | null => {
  if (!isJsonRecord(value)) {
    return null
  }
  return Object.keys(value).every((key) => allowedKeys.has(key)) ? value : null
}

export const githubIssueNumber = (
  provider: GitHubProviderConfig,
  context: HostToolContext,
): number | null => {
  const nativeRef = context.nativeRef
  if (
    nativeRef === null ||
    nativeRef['owner'] !== provider.owner ||
    nativeRef['repository'] !== provider.repository
  ) {
    return null
  }
  const number = nativeRef['issue_number']
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : null
}

const hostToolFailureFrom = (error: TrackerError): HostToolResult => {
  if (error.category === 'tracker_rate_limited') {
    return toolFailure('rate_limited', 'GitHub rate limit exceeded', true, error.retryAfterMs)
  }
  if (error.category === 'tracker_request') {
    return toolFailure('transport_error', 'GitHub request failed', true)
  }
  if (error.category === 'tracker_status' && /HTTP 401/u.test(error.message)) {
    return toolFailure('missing_auth', 'GitHub rejected the configured credential')
  }
  if (error.category === 'tracker_status' && /HTTP 403/u.test(error.message)) {
    return toolFailure('authorization_failed', 'GitHub denied this mutation')
  }
  return toolFailure('provider_error', error.message, error.retryable, error.retryAfterMs)
}

/**
 * Runs one host-tool request to the JSON-safe result the host boundary promises.
 *
 * The port hands tool results back as a promise, so this leaves Effect and with it any client the
 * caller had in context; `httpClient` is the adapter's own binding, carried from construction.
 */
export const githubToolValue = (
  effect: Effect.Effect<JsonValue, TrackerError>,
  httpClient?: HttpClient.HttpClient,
): Promise<HostToolResult> =>
  Effect.runPromise(
    withBoundHttpClient(httpClient)(effect).pipe(
      Effect.match({
        onFailure: hostToolFailureFrom,
        onSuccess: (data): HostToolResult => ({ success: true, data }),
      }),
    ),
  )

export const requiredResponseUrl = (body: JsonValue | null, field: string): string => {
  if (!isJsonRecord(body) || typeof body[field] !== 'string' || body[field].length === 0) {
    throw trackerResponseError(`GitHub response is missing ${field}`)
  }
  return body[field]
}
