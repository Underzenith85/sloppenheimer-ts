import {
  issueId,
  issueIdentifier,
  type BlockerRef,
  type Issue,
  type JsonValue,
} from '../../domain/domain.js'
import { TrackerError } from '../../errors.js'
import { isJsonArray } from '../../support/json.js'
import type { GitHubProviderConfig } from './provider.js'
import { isJsonRecord, trackerResponseError } from './client.js'

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

const nullableString = (value: JsonValue | undefined): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  return value
}

const nonEmptyString = (value: JsonValue | undefined): string | null => {
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

/** GitHub returns labels either as objects or, on some payload shapes, as bare strings. */
const decodeGitHubLabel = (value: JsonValue): GitHubLabel | null => {
  if (typeof value === 'string') {
    return { name: value }
  }
  if (!isJsonRecord(value)) {
    return null
  }
  const name = value['name']
  return name === null || typeof name === 'string' ? { name } : null
}

export const decodeGitHubIssue = (value: JsonValue): GitHubIssue => {
  if (!isJsonRecord(value)) {
    throw trackerResponseError('GitHub issue is not an object')
  }
  const number = value['number']
  const nodeId = value['node_id']
  const title = value['title']
  const state = value['state']
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    typeof nodeId !== 'string' ||
    nodeId.length === 0 ||
    typeof title !== 'string' ||
    title.length === 0 ||
    typeof state !== 'string' ||
    state.length === 0
  ) {
    throw trackerResponseError('GitHub issue is missing required fields')
  }
  const rawLabels = value['labels']
  const labels = isJsonArray(rawLabels)
    ? rawLabels.flatMap((item) => {
        const label = decodeGitHubLabel(item)
        return label === null ? [] : [label]
      })
    : []
  const rawAssignee = value['assignee']
  return {
    number,
    nodeId,
    title,
    body: nullableString(value['body']),
    state,
    htmlUrl: nonEmptyString(value['html_url']),
    assigneeLogin: isJsonRecord(rawAssignee) ? nonEmptyString(rawAssignee['login']) : null,
    labels,
    isPullRequest: value['pull_request'] !== undefined && value['pull_request'] !== null,
    createdAt: nonEmptyString(value['created_at']),
    updatedAt: nonEmptyString(value['updated_at']),
  }
}

export const decodeGitHubDependency = (value: JsonValue): GitHubDependency => {
  if (!isJsonRecord(value)) {
    throw trackerResponseError('GitHub issue dependency is not an object')
  }
  const id = value['id']
  const number = value['number']
  const title = value['title']
  const state = value['state']
  const repositoryUrl = value['repository_url']
  const htmlUrl = value['html_url']
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    typeof title !== 'string' ||
    title.length === 0 ||
    typeof state !== 'string' ||
    state.length === 0 ||
    typeof repositoryUrl !== 'string' ||
    typeof htmlUrl !== 'string'
  ) {
    throw trackerResponseError('GitHub issue dependency is missing required fields')
  }
  return { id, number, title, state, repositoryUrl, htmlUrl }
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
  if (!isJsonArray(body)) {
    throw trackerResponseError('GitHub issue list is not an array')
  }
  const issues: Issue[] = []
  const malformed: string[] = []
  for (const [index, item] of body.entries()) {
    try {
      issues.push(normalizeIssue(decodeGitHubIssue(item), provider))
    } catch (error: unknown) {
      if (!(error instanceof TrackerError)) {
        throw error
      }
      const candidate = isJsonRecord(item) ? item['number'] : undefined
      malformed.push(
        `index ${String(index)}${typeof candidate === 'number' ? ` (number ${String(candidate)})` : ''}: ${error.message}`,
      )
    }
  }
  return { issues, malformed }
}
