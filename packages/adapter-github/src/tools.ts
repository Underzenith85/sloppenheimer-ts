import type * as HttpClient from '@effect/platform/HttpClient'
import { Effect, Redacted } from 'effect'

import type { JsonObject, JsonValue } from '@sloppenheimer/core/domain/domain.js'
import { TrackerError } from '@sloppenheimer/core/domain/errors.js'
import type { GitHubProviderConfig } from './provider.js'
import type {
  HostToolContext,
  HostToolFailureCode,
  HostToolResult,
  HostToolSpec,
} from '@sloppenheimer/core/domain/host-tools.js'
import { unsupportedHostTool } from '@sloppenheimer/core/domain/host-tools.js'
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

/**
 * The guard chain every GitHub host tool runs before it does anything.
 *
 * Three questions, in this order: is this a tool this capability declares, is there a credential to
 * make the call with, and does the session's issue belong to the repository this adapter is bound
 * to. Only the last needs the request at all — the first two are refusals no argument could rescue
 * — and each is a distinct failure code the agent is expected to read, which is why they are
 * separate results rather than one `invalid_arguments`.
 *
 * `run` receives the issue number those guards established, so a tool body starts from a session it
 * knows is valid. It answers with a `HostToolResult` for an argument it rejects outright, or with
 * the effect whose value becomes the tool's data — {@link githubToolValue} carries that back across
 * the promise boundary the port hands results over.
 */
export const githubHostToolExecutor =
  (
    specs: readonly HostToolSpec[],
    provider: GitHubProviderConfig,
    httpClient: HttpClient.HttpClient | undefined,
    run: (
      name: string,
      argumentsValue: JsonValue,
      issueNumber: number,
    ) => Effect.Effect<JsonValue, TrackerError> | HostToolResult,
  ) =>
  async (
    name: string,
    argumentsValue: JsonValue,
    context: HostToolContext,
  ): Promise<HostToolResult> => {
    if (!specs.some((spec) => spec.name === name)) {
      return unsupportedHostTool(name)
    }
    if (Redacted.value(provider.token).length === 0) {
      return toolFailure('missing_auth', 'GitHub credential is not configured')
    }
    const issueNumber = githubIssueNumber(provider, context)
    if (issueNumber === null) {
      return invalidToolArguments('Session issue context is invalid for this GitHub adapter')
    }
    const outcome = run(name, argumentsValue, issueNumber)
    return Effect.isEffect(outcome) ? githubToolValue(outcome, httpClient) : outcome
  }

export const requiredResponseUrl = (body: JsonValue | null, field: string): string => {
  if (!isJsonRecord(body) || typeof body[field] !== 'string' || body[field].length === 0) {
    throw trackerResponseError(`GitHub response is missing ${field}`)
  }
  return body[field]
}
