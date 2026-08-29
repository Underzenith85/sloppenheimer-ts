import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { JsonObject } from '../src/domain.js'
import { makeGitHubTracker } from '../src/tracker.js'
import type { GitHubProviderConfig } from '../src/workflow.js'

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'symphony',
  token: 'secret',
  apiBaseUrl: 'https://api.example.test',
}

const githubIssue = (number: number): JsonObject => ({
  number,
  node_id: `node-${String(number)}`,
  title: `Issue ${String(number)}`,
  body: null,
  state: 'open',
  html_url: `https://example.test/issues/${String(number)}`,
  assignee: null,
  labels: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
})

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === 'string') {
    return input
  }
  return input instanceof URL ? input.href : input.url
}

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('GitHub tracker pagination', (): void => {
  it('combines all pages and removes duplicate issues', async (): Promise<void> => {
    const secondPageUrl =
      'https://api.example.test/repos/example/symphony/issues?state=open&per_page=100&page=2'
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      if (requestUrl(input) === secondPageUrl) {
        return Response.json([githubIssue(2), githubIssue(3)])
      }
      return Response.json([githubIssue(1), githubIssue(2)], {
        headers: {
          Link: `<${secondPageUrl}>; rel="next", <${secondPageUrl}>; rel="last"`,
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByStates(['open']),
    )

    expect(issues.map((issue) => issue.id)).toEqual(['1', '2', '3'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      'https://api.example.test/repos/example/symphony/issues?state=open&per_page=100',
      secondPageUrl,
    ])
  })

  it('preserves response decoding errors from later pages', async (): Promise<void> => {
    const secondPageUrl =
      'https://api.example.test/repos/example/symphony/issues?state=open&per_page=100&page=2'
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      if (requestUrl(input) === secondPageUrl) {
        return Response.json({ issue: githubIssue(2) })
      }
      return Response.json([githubIssue(1)], {
        headers: { Link: `<${secondPageUrl}>; rel="next"` },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'])),
    )

    expect(error.category).toBe('tracker_response')
    expect(error.retryable).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not send the tracker token to a different origin', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      Response.json([githubIssue(1)], {
        headers: { Link: '<https://attacker.example.test/issues?page=2>; rel="next"' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'])),
    )

    expect(error.category).toBe('tracker_pagination')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
