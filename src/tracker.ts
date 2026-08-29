import { Effect } from 'effect'

import { issueId, issueIdentifier, type Issue, type IssueId, type JsonValue } from './domain.js'
import { TrackerError } from './errors.js'
import type { GitHubProviderConfig } from './workflow.js'

export type TrackerAdapter = Readonly<{
  fetchIssuesByStates: (states: readonly string[]) => Effect.Effect<readonly Issue[], TrackerError>
  fetchIssuesByIds: (ids: readonly IssueId[]) => Effect.Effect<readonly Issue[], TrackerError>
  secretEnvironmentNames: readonly string[]
}>

type JsonRecord = Record<string, JsonValue>

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }
  return isJsonRecord(value) && Object.values(value).every(isJsonValue)
}

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value)

type GitHubLabel = Readonly<{ name: string | null }>
type GitHubUser = Readonly<{ login: string }>
type GitHubIssue = Readonly<{
  number: number
  nodeId: string
  title: string
  body: string | null
  state: string
  htmlUrl: string
  assignee: GitHubUser | null
  labels: readonly GitHubLabel[]
  isPullRequest: boolean
  createdAt: string
  updatedAt: string
}>

const nullableString = (value: JsonValue | undefined): string | null =>
  typeof value === 'string' ? value : null
const parseDate = (value: string): Date | null => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const decodeGitHubLabel = (value: JsonValue): GitHubLabel | null => {
  if (!isJsonRecord(value)) {
    return null
  }
  const name = value['name']
  return name === null || typeof name === 'string' ? { name } : null
}

const decodeGitHubIssue = (value: JsonValue): GitHubIssue => {
  if (!isJsonRecord(value)) {
    throw new TrackerError({
      category: 'tracker_response',
      message: 'GitHub issue is not an object',
      retryable: false,
    })
  }
  const number = value['number']
  const nodeId = value['node_id']
  const title = value['title']
  const state = value['state']
  const htmlUrl = value['html_url']
  const createdAt = value['created_at']
  const updatedAt = value['updated_at']
  if (
    typeof number !== 'number' ||
    !Number.isInteger(number) ||
    typeof nodeId !== 'string' ||
    typeof title !== 'string' ||
    title.length === 0 ||
    typeof state !== 'string' ||
    state.length === 0 ||
    typeof htmlUrl !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    throw new TrackerError({
      category: 'tracker_response',
      message: 'GitHub issue is missing required fields',
      retryable: false,
    })
  }
  const rawLabels = value['labels']
  const labels =
    rawLabels !== undefined && isJsonArray(rawLabels)
      ? rawLabels.flatMap((item) => {
          const label = decodeGitHubLabel(item)
          return label === null ? [] : [label]
        })
      : []
  const rawAssignee = value['assignee']
  const assignee =
    isJsonRecord(rawAssignee) && typeof rawAssignee['login'] === 'string'
      ? { login: rawAssignee['login'] }
      : null
  return {
    number,
    nodeId,
    title,
    body: nullableString(value['body']),
    state,
    htmlUrl,
    assignee,
    labels,
    isPullRequest: value['pull_request'] !== undefined,
    createdAt,
    updatedAt,
  }
}

const normalizeIssue = (source: GitHubIssue, provider: GitHubProviderConfig): Issue => {
  const labels = [
    ...new Set(
      source.labels.flatMap((label) => {
        const name = label.name?.trim().toLowerCase()
        return name === undefined || name.length === 0 ? [] : [name]
      }),
    ),
  ]
  const priorityLabel = labels.find((label) => /^priority:[1-4]$/u.test(label))
  const priority = priorityLabel === undefined ? null : Number(priorityLabel.slice(-1))

  return {
    id: issueId(String(source.number)),
    nativeRef: {
      node_id: source.nodeId,
      issue_number: source.number,
      owner: provider.owner,
      repository: provider.repository,
    },
    identifier: issueIdentifier(
      `${provider.owner}/${provider.repository}#${String(source.number)}`,
    ),
    title: source.title,
    description: source.body,
    priority,
    state: source.state,
    branchName: null,
    url: source.htmlUrl,
    assigneeId: source.assignee?.login ?? null,
    labels,
    blockedBy: [],
    dispatchable: !source.isPullRequest,
    createdAt: parseDate(source.createdAt),
    updatedAt: parseDate(source.updatedAt),
  }
}

const githubRequest = (
  provider: GitHubProviderConfig,
  path: string,
): Effect.Effect<JsonValue, TrackerError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${provider.apiBaseUrl}${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${provider.token}`,
          'User-Agent': 'symphony-ts/0.1',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
      if (response.status === 403 && response.headers.has('retry-after')) {
        throw new TrackerError({
          category: 'tracker_rate_limited',
          message: 'GitHub rate limit exceeded',
          retryable: true,
        })
      }
      if (!response.ok) {
        throw new TrackerError({
          category: 'tracker_status',
          message: `GitHub returned HTTP ${String(response.status)}`,
          retryable: response.status >= 500,
        })
      }
      const body: unknown = await response.json()
      if (!isJsonValue(body)) {
        throw new TrackerError({
          category: 'tracker_response',
          message: 'GitHub returned non-JSON data',
          retryable: false,
        })
      }
      return body
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

export const makeGitHubTracker = (provider: GitHubProviderConfig): TrackerAdapter => {
  const prefix = `/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
  return {
    secretEnvironmentNames: ['GITHUB_TOKEN', 'GH_TOKEN'],
    fetchIssuesByStates: (states): Effect.Effect<readonly Issue[], TrackerError> => {
      if (states.length === 0) {
        return Effect.succeed([])
      }
      const fetchState = (state: string): Effect.Effect<readonly Issue[], TrackerError> =>
        githubRequest(
          provider,
          `${prefix}/issues?state=${encodeURIComponent(state.toLowerCase())}&per_page=100`,
        ).pipe(
          Effect.flatMap((value) => {
            if (!isJsonArray(value)) {
              return Effect.fail(
                new TrackerError({
                  category: 'tracker_response',
                  message: 'GitHub issue list is not an array',
                  retryable: false,
                }),
              )
            }
            const issues: Issue[] = []
            for (const item of value) {
              try {
                const issue = normalizeIssue(decodeGitHubIssue(item), provider)
                if (issue.dispatchable) {
                  issues.push(issue)
                }
              } catch (error: unknown) {
                if (!(error instanceof TrackerError)) {
                  throw error
                }
              }
            }
            return Effect.succeed(issues)
          }),
        )
      return Effect.forEach(states, fetchState, { concurrency: 1 }).pipe(
        Effect.map((groups) => groups.flat()),
      )
    },
    fetchIssuesByIds: (ids): Effect.Effect<readonly Issue[], TrackerError> => {
      if (ids.length === 0) {
        return Effect.succeed([])
      }
      return Effect.forEach(
        [...new Set(ids)],
        (id) =>
          githubRequest(provider, `${prefix}/issues/${encodeURIComponent(id)}`).pipe(
            Effect.map((value) => normalizeIssue(decodeGitHubIssue(value), provider)),
          ),
        { concurrency: 4 },
      )
    },
  }
}
