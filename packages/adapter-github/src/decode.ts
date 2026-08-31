import {
  issueId,
  issueIdentifier,
  type BlockerRef,
  type Issue,
  type JsonValue,
} from '@symphony/core/domain/domain.js'
import { Either, Schema } from 'effect'

import { TrackerError } from '@symphony/core/domain/errors.js'
import { isJsonValue } from '@symphony/core/support/json.js'
import type { GitHubProviderConfig } from './provider.js'
import { trackerResponseError } from './client.js'

export type GitHubLabel = Readonly<{ name: string | null }>
export type GitHubIssue = Readonly<{
  number: number
  nodeId: string
  title: string
  body: string | null
  state: string
  htmlUrl: string | null
  assigneeLogin: string | null
  labels: readonly GitHubLabel[]
  isPullRequest: boolean
  createdAt: string | null
  updatedAt: string | null
}>

export type GitHubDependency = Readonly<{
  id: number
  number: number
  title: string
  state: string
  repositoryUrl: string
  htmlUrl: string
}>

const nullableString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  return value
}

const nonEmptyString = (value: unknown): string | null => {
  const text = nullableString(value)
  return text === null || text.length === 0 ? null : text
}

const parseDate = (value: string | null): Date | null => {
  if (value === null) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const nonEmpty = Schema.String.pipe(Schema.filter((value) => value.length > 0))
const positiveSafeInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isSafeInteger(value) && value > 0),
)
const safeInteger = Schema.Number.pipe(Schema.filter(Number.isSafeInteger))
const jsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const githubLabel = Schema.Union(
  Schema.String,
  Schema.Struct({ name: Schema.NullOr(Schema.String) }),
)
const githubIssue = Schema.Struct({
  number: positiveSafeInteger,
  node_id: nonEmpty,
  title: nonEmpty,
  state: nonEmpty,
  body: Schema.optional(Schema.Unknown),
  html_url: Schema.optional(Schema.Unknown),
  assignee: Schema.optional(Schema.Unknown),
  labels: Schema.optional(Schema.Array(Schema.Unknown)),
  pull_request: Schema.optional(Schema.Unknown),
  created_at: Schema.optional(Schema.Unknown),
  updated_at: Schema.optional(Schema.Unknown),
})
const githubDependency = Schema.Struct({
  id: safeInteger,
  number: positiveSafeInteger,
  title: nonEmpty,
  state: nonEmpty,
  repository_url: Schema.String,
  html_url: Schema.String,
})
const githubIssuePage = Schema.Array(Schema.declare(isJsonValue))

const decodeOrThrow = <Value, Encoded>(
  schema: Schema.Schema<Value, Encoded>,
  value: unknown,
  message: string,
): Value =>
  Either.match(Schema.decodeUnknownEither(schema)(value), {
    onLeft: (cause) => {
      throw trackerResponseError(message, cause)
    },
    onRight: (decoded) => decoded,
  })

/** GitHub returns labels either as objects or, on some payload shapes, as bare strings. */
const decodeGitHubLabel = (value: unknown): GitHubLabel | null =>
  Either.match(Schema.decodeUnknownEither(githubLabel)(value), {
    onLeft: () => null,
    onRight: (label) => (typeof label === 'string' ? { name: label } : label),
  })

export const decodeGitHubIssue = (value: JsonValue): GitHubIssue => {
  const decoded = decodeOrThrow(githubIssue, value, 'GitHub issue is missing required fields')
  const rawLabels = decoded.labels
  const labels = Array.isArray(rawLabels)
    ? rawLabels.flatMap((item) => {
        const label = decodeGitHubLabel(item)
        return label === null ? [] : [label]
      })
    : []
  const rawAssignee = decoded.assignee
  const assignee = Either.getOrNull(Schema.decodeUnknownEither(jsonRecord)(rawAssignee))
  return {
    number: decoded.number,
    nodeId: decoded.node_id,
    title: decoded.title,
    body: nullableString(decoded.body),
    state: decoded.state,
    htmlUrl: nonEmptyString(decoded.html_url),
    assigneeLogin: assignee === null ? null : nonEmptyString(assignee['login']),
    labels,
    isPullRequest: decoded.pull_request !== undefined && decoded.pull_request !== null,
    createdAt: nonEmptyString(decoded.created_at),
    updatedAt: nonEmptyString(decoded.updated_at),
  }
}

export const decodeGitHubDependency = (value: JsonValue): GitHubDependency => {
  const decoded = decodeOrThrow(
    githubDependency,
    value,
    'GitHub issue dependency is missing required fields',
  )
  return {
    id: decoded.id,
    number: decoded.number,
    title: decoded.title,
    state: decoded.state,
    repositoryUrl: decoded.repository_url,
    htmlUrl: decoded.html_url,
  }
}

export const normalizeDependency = (
  source: GitHubDependency,
  provider: GitHubProviderConfig,
): BlockerRef => {
  try {
    const repositoryUrl = new URL(source.repositoryUrl)
    if (repositoryUrl.origin !== new URL(provider.apiBaseUrl).origin) {
      throw new Error('unexpected dependency repository origin')
    }
    const match = /\/repos\/([^/]+)\/([^/]+)\/?$/u.exec(repositoryUrl.pathname)
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error('invalid dependency repository URL')
    }
    const owner = decodeURIComponent(match[1])
    const repository = decodeURIComponent(match[2])
    return {
      id: String(source.id),
      identifier: issueIdentifier(`${owner}/${repository}#${String(source.number)}`),
      title: source.title,
      state: source.state,
      url: source.htmlUrl,
    }
  } catch (cause: unknown) {
    throw trackerResponseError('GitHub issue dependency has an invalid repository URL', cause)
  }
}

/**
 * Section 11.3 normalization. Dispatch identity is the opaque issue number, native identity keeps
 * the provider scope plus GraphQL node id, and every nullable field is normalized to `null` rather
 * than an empty value.
 */
export const normalizeIssue = (
  source: GitHubIssue,
  provider: GitHubProviderConfig,
  blockedBy: readonly BlockerRef[] = [],
): Issue => {
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
    assigneeId: source.assigneeLogin,
    labels,
    blockedBy,
    dispatchable: !source.isPullRequest,
    createdAt: parseDate(source.createdAt),
    updatedAt: parseDate(source.updatedAt),
  }
}

export type DecodedPage = Readonly<{
  issues: readonly Issue[]
  malformed: readonly string[]
}>

export const decodeIssuePage = (body: JsonValue, provider: GitHubProviderConfig): DecodedPage => {
  const records = decodeOrThrow(githubIssuePage, body, 'GitHub issue list is not an array')
  const issues: Issue[] = []
  const malformed: string[] = []
  for (const [index, item] of records.entries()) {
    try {
      issues.push(normalizeIssue(decodeGitHubIssue(item), provider))
    } catch (error: unknown) {
      if (!(error instanceof TrackerError)) {
        throw error
      }
      const candidateRecord = Either.getOrNull(Schema.decodeUnknownEither(jsonRecord)(item))
      const candidate = candidateRecord?.['number']
      malformed.push(
        `index ${String(index)}${typeof candidate === 'number' ? ` (number ${String(candidate)})` : ''}: ${error.message}`,
      )
    }
  }
  return { issues, malformed }
}
