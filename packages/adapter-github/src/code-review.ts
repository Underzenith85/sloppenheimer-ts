import type * as HttpClient from '@effect/platform/HttpClient'
import { Effect, Option, Schema } from 'effect'

import type { Issue } from '@sloppenheimer/core/domain/domain.js'
import { issueBranchName } from '@sloppenheimer/core/domain/handoff.js'
import { TrackerError } from '@sloppenheimer/core/domain/errors.js'
import type { GitHubProviderConfig } from './provider.js'
import type { HostToolSpec } from '@sloppenheimer/core/domain/host-tools.js'
import type { CodeReviewPort, HandoffResult } from '@sloppenheimer/core/ports/code-review.js'
import {
  decodeTracker,
  githubJson,
  githubPageSize,
  trackerCause,
  trackerResponseError,
  githubTransportFor,
  type GitHubTransportBinding,
} from './client.js'
import { makeGitHubPullRequestMonitor } from './pull-requests.js'
import { exactObject, githubHostToolExecutor, invalidToolArguments } from './tools.js'

const pullRequestResponse = Schema.Struct({
  html_url: Schema.String.pipe(Schema.filter((value) => value.length > 0)),
})
const pullRequestList = Schema.Array(Schema.Unknown)

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

const makeGitHubCodeReviewToolExecutor = (
  provider: GitHubProviderConfig,
  prefix: string,
  bind: GitHubTransportBinding,
): CodeReviewPort['executeTool'] =>
  githubHostToolExecutor(
    githubCodeReviewToolSpecs,
    provider,
    bind,
    (_name, argumentsValue, issueNumber) => {
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
      return githubJson(
        provider,
        `${provider.apiBaseUrl}${prefix}/pulls/${String(pullRequestNumber)}`,
      ).pipe(
        Effect.flatMap(({ body }) =>
          decodeTracker(
            pullRequestResponse,
            body,
            trackerCause('GitHub pull request response is invalid'),
          ).pipe(Effect.map((pullRequest) => pullRequest.html_url)),
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
      )
    },
  )

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
    Effect.flatMap(({ body }) =>
      decodeTracker(pullRequestList, body, trackerCause('GitHub pull request list is invalid')),
    ),
    Effect.flatMap((pullRequests) => {
      const first = pullRequests[0]
      return first === undefined
        ? Effect.succeed(Option.none<string>())
        : decodeTracker(
            pullRequestResponse,
            first,
            trackerCause('GitHub pull request is invalid'),
          ).pipe(Effect.map((pullRequest) => Option.some(pullRequest.html_url)))
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
      decodeTracker(pullRequestResponse, body, trackerCause('GitHub pull request is invalid')).pipe(
        Effect.map((pullRequest) => pullRequest.html_url),
      ),
    ),
  )

/**
 * `httpClient` binds this capability to one client, as it does for the tracker: the operations that
 * stay in Effect otherwise read one from their caller's context, and `executeTool` cannot.
 *
 * Construction is an effect only because the limiter this capability paces against belongs to the
 * provider generation rather than to this instance: reading it is how a code review built beside a
 * tracker ends up on the tracker's limiter instead of one of its own.
 */
export const makeGitHubCodeReview = (
  configuredProvider: GitHubProviderConfig,
  httpClient?: HttpClient.HttpClient,
): Effect.Effect<CodeReviewPort> =>
  Effect.gen(function* () {
    const provider = Object.freeze({ ...configuredProvider })
    const prefix = `/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
    const bindClient = yield* githubTransportFor(provider, httpClient)
    const pullRequests = makeGitHubPullRequestMonitor(provider, bindClient)
    return {
      toolSpecs: githubCodeReviewToolSpecs,
      executeTool: makeGitHubCodeReviewToolExecutor(provider, prefix, bindClient),
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
                    catch: trackerCause('GitHub pull request URL is invalid'),
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
                    catch: trackerCause('GitHub pull request URL is invalid'),
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
  })
