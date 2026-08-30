import type * as HttpClient from '@effect/platform/HttpClient'
import { Effect, Option } from 'effect'

import type { Issue, JsonValue } from '../../domain/domain.js'
import { issueBranchName } from '../../domain/handoff.js'
import { TrackerError } from '../../errors.js'
import type { GitHubProviderConfig } from '../../config/tracker-config.js'
import type { HostToolResult, HostToolSpec } from '../../host-tools.js'
import { unsupportedHostTool } from '../../host-tools.js'
import type { CodeReviewPort, HandoffResult } from '../../ports/code-review.js'
import { isJsonArray } from '../../support/json.js'
import {
  githubJson,
  githubPageSize,
  isJsonRecord,
  trackerResponseError,
  withBoundHttpClient,
} from './client.js'
import { makeGitHubPullRequestMonitor } from './pull-requests.js'
import {
  exactObject,
  githubIssueNumber,
  githubToolValue,
  invalidToolArguments,
  requiredResponseUrl,
  toolFailure,
} from './tools.js'

const githubCodeReviewToolSpecs: readonly HostToolSpec[] = Object.freeze([
  Object.freeze({
    name: 'github_link_pull_request',
    description:
      'Link a pull request in the configured repository to the current issue by adding a handoff comment after verifying the pull request exists.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['pull_request_number']),
      properties: Object.freeze({
        pull_request_number: Object.freeze({ type: 'integer', minimum: 1 }),
      }),
    }),
  }),
])

const makeGitHubCodeReviewToolExecutor =
  (
    provider: GitHubProviderConfig,
    prefix: string,
    httpClient: HttpClient.HttpClient | undefined,
  ): CodeReviewPort['executeTool'] =>
  async (name, argumentsValue, context): Promise<HostToolResult> => {
    if (!githubCodeReviewToolSpecs.some((spec) => spec.name === name)) {
      return unsupportedHostTool(name)
    }
    if (provider.token.length === 0) {
      return toolFailure('missing_auth', 'GitHub credential is not configured')
    }
    const issueNumber = githubIssueNumber(provider, context)
    if (issueNumber === null) {
      return invalidToolArguments('Session issue context is invalid for this GitHub adapter')
    }
    const argumentsObject = exactObject(argumentsValue, new Set(['pull_request_number']))
    const pullRequestNumber = argumentsObject?.['pull_request_number']
    if (
      argumentsObject === null ||
      typeof pullRequestNumber !== 'number' ||
      !Number.isSafeInteger(pullRequestNumber) ||
      pullRequestNumber <= 0
    ) {
      return invalidToolArguments(
        'github_link_pull_request requires only a positive pull_request_number integer',
      )
    }
    return githubToolValue(
      githubJson(
        provider,
        `${provider.apiBaseUrl}${prefix}/pulls/${String(pullRequestNumber)}`,
      ).pipe(
        Effect.flatMap(({ body }) =>
          Effect.try({
            try: () => requiredResponseUrl(body, 'html_url'),
            catch: (cause: unknown) =>
              cause instanceof TrackerError
                ? cause
                : trackerResponseError('GitHub pull request response is invalid', cause),
          }),
        ),
        Effect.flatMap((pullRequestUrl) =>
          githubJson(
            provider,
            `${provider.apiBaseUrl}${prefix}/issues/${String(issueNumber)}/comments`,
            {
              method: 'POST',
              body: JSON.stringify({
                body: `Linked pull request for handoff: ${pullRequestUrl}`,
              }),
            },
          ).pipe(
            Effect.as({
              issue_number: issueNumber,
              pull_request_number: pullRequestNumber,
              pull_request_url: pullRequestUrl,
            }),
          ),
        ),
      ),
      httpClient,
    )
  }

const pullRequestNumberFromUrl = (url: string): number => {
  const match = /\/pulls?\/(\d+)(?:\/)?$/u.exec(url)
  const number = match?.[1] === undefined ? Number.NaN : Number(match[1])
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw trackerResponseError('GitHub pull request URL has no valid number')
  }
  return number
}

const githubBranchExists = (
  provider: GitHubProviderConfig,
  prefix: string,
  branchName: string,
): Effect.Effect<boolean, TrackerError> =>
  githubJson(
    provider,
    `${provider.apiBaseUrl}${prefix}/git/ref/heads/${encodeURIComponent(branchName)}`,
    undefined,
    [404],
  ).pipe(Effect.map(({ status }) => status !== 404))

const decodePullRequestUrl = (value: JsonValue | null): string => {
  if (!isJsonRecord(value) || typeof value['html_url'] !== 'string') {
    throw trackerResponseError('GitHub pull request is missing html_url')
  }
  return value['html_url']
}

/**
 * The open pull request for `branchName`, if GitHub has one. Absence decides the next branch in
 * both handoff paths, so it is an `Option` rather than a `null` carried deeper.
 */
const findPullRequest = (
  provider: GitHubProviderConfig,
  prefix: string,
  branchName: string,
): Effect.Effect<Option.Option<string>, TrackerError> =>
  githubJson(
    provider,
    `${provider.apiBaseUrl}${prefix}/pulls?state=open&head=${encodeURIComponent(`${provider.owner}:${branchName}`)}&base=${encodeURIComponent(provider.baseBranch)}&per_page=${String(githubPageSize)}`,
  ).pipe(
    Effect.flatMap(({ body }) => {
      if (!isJsonArray(body)) {
        return Effect.fail(trackerResponseError('GitHub pull request list is not an array'))
      }
      const first = body[0]
      return first === undefined
        ? Effect.succeed(Option.none<string>())
        : Effect.try({
            try: () => Option.some(decodePullRequestUrl(first)),
            catch: (cause: unknown) =>
              cause instanceof TrackerError
                ? cause
                : trackerResponseError('GitHub pull request is invalid', cause),
          })
    }),
  )

const createPullRequest = (
  provider: GitHubProviderConfig,
  prefix: string,
  issue: Issue,
  branchName: string,
): Effect.Effect<string, TrackerError> =>
  githubJson(provider, `${provider.apiBaseUrl}${prefix}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      base: provider.baseBranch,
      head: branchName,
      title: issue.title,
      body: `Closes #${issue.id}`,
    }),
  }).pipe(
    Effect.flatMap(({ body }) =>
      Effect.try({
        try: () => decodePullRequestUrl(body),
        catch: (cause: unknown) =>
          cause instanceof TrackerError
            ? cause
            : trackerResponseError('GitHub pull request is invalid', cause),
      }),
    ),
  )

/**
 * `httpClient` binds this capability to one client, as it does for the tracker: the operations that
 * stay in Effect otherwise read one from their caller's context, and `executeTool` cannot.
 */
export const makeGitHubCodeReview = (
  configuredProvider: GitHubProviderConfig,
  httpClient?: HttpClient.HttpClient,
): CodeReviewPort => {
  const provider = Object.freeze({ ...configuredProvider })
  const prefix = `/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
  const pullRequests = makeGitHubPullRequestMonitor(provider, httpClient)
  const bindClient = withBoundHttpClient(httpClient)
  return {
    toolSpecs: githubCodeReviewToolSpecs,
    executeTool: makeGitHubCodeReviewToolExecutor(provider, prefix, httpClient),
    handoffCompletedWork: (issue) => {
      const branchName = issueBranchName(issue)
      return bindClient(
        githubBranchExists(provider, prefix, branchName).pipe(
          Effect.flatMap((exists) => {
            if (!exists) {
              return Effect.succeed<HandoffResult>({ _tag: 'NoBranch', branchName })
            }
            return findPullRequest(provider, prefix, branchName).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    createPullRequest(provider, prefix, issue, branchName).pipe(
                      Effect.map((pullRequestUrl) => ({ pullRequestUrl, created: true })),
                    ),
                  onSome: (pullRequestUrl: string) =>
                    Effect.succeed({ pullRequestUrl, created: false }),
                }),
              ),
              Effect.flatMap(({ pullRequestUrl, created }) =>
                Effect.try({
                  try: (): HandoffResult => ({
                    _tag: 'PullRequest',
                    branchName,
                    pullRequestUrl,
                    pullRequestNumber: pullRequestNumberFromUrl(pullRequestUrl),
                    created,
                  }),
                  catch: (cause: unknown) =>
                    cause instanceof TrackerError
                      ? cause
                      : trackerResponseError('GitHub pull request URL is invalid', cause),
                }),
              ),
            )
          }),
        ),
      )
    },
    findExistingHandoff: (issue) => {
      const branchName = issueBranchName(issue)
      return bindClient(
        findPullRequest(provider, prefix, branchName).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed<HandoffResult>({ _tag: 'NoBranch', branchName }),
              onSome: (pullRequestUrl: string) =>
                Effect.try({
                  try: (): HandoffResult => ({
                    _tag: 'PullRequest',
                    branchName,
                    pullRequestUrl,
                    pullRequestNumber: pullRequestNumberFromUrl(pullRequestUrl),
                    created: false,
                  }),
                  catch: (cause: unknown) =>
                    cause instanceof TrackerError
                      ? cause
                      : trackerResponseError('GitHub pull request URL is invalid', cause),
                }),
            }),
          ),
        ),
      )
    },
    inspectPullRequest: pullRequests.inspect,
    mergePullRequest: pullRequests.merge,
    requestPullRequestReview: pullRequests.requestReview,
    resolveReviewThreads: pullRequests.resolveThreads,
  }
}
