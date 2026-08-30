import { Effect, Logger } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { issueId, type JsonObject } from '../src/domain/domain.js'
import { makeGitHubTracker } from '../src/tracker.js'
import type { GitHubProviderConfig } from '../src/config/tracker-config.js'

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'symphony',
  token: 'secret',
  tokenEnvironmentName: 'CUSTOM_GITHUB_TOKEN',
  apiBaseUrl: 'https://api.example.test',
  baseBranch: 'main',
}

const githubIssue = (number: number, labels: readonly string[] = []): JsonObject => ({
  number,
  node_id: `node-${String(number)}`,
  title: `Issue ${String(number)}`,
  body: null,
  state: 'open',
  html_url: `https://example.test/issues/${String(number)}`,
  assignee: null,
  labels: labels.map((name) => ({ name })),
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
})

const githubDependency = (number: number, state = 'open'): JsonObject => ({
  id: 10_000 + number,
  number,
  title: `Blocker ${String(number)}`,
  state,
  repository_url: 'https://api.example.test/repos/example/symphony',
  html_url: `https://example.test/issues/${String(number)}`,
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

describe('GitHub tracker authentication provenance', (): void => {
  it('declares the configured secret variable and all fallback aliases', (): void => {
    expect(makeGitHubTracker(provider).secretEnvironmentNames).toEqual([
      'CUSTOM_GITHUB_TOKEN',
      'GITHUB_TOKEN',
      'GH_TOKEN',
    ])
  })

  it('deduplicates a configured fallback alias', (): void => {
    expect(
      makeGitHubTracker({ ...provider, tokenEnvironmentName: 'GH_TOKEN' }).secretEnvironmentNames,
    ).toEqual(['GH_TOKEN', 'GITHUB_TOKEN'])
  })
})

describe('GitHub tracker pagination', (): void => {
  it('combines all pages and removes duplicate issues', async (): Promise<void> => {
    const secondPageUrl =
      'https://api.example.test/repos/example/symphony/issues?state=open&per_page=100&page=2'
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        if (requestUrl(input).includes('/dependencies/blocked_by')) {
          return Response.json([])
        }
        if (requestUrl(input) === secondPageUrl) {
          return Response.json([githubIssue(2), githubIssue(3)])
        }
        return Response.json([githubIssue(1), githubIssue(2)], {
          headers: {
            Link: `<${secondPageUrl}>; rel="next", <${secondPageUrl}>; rel="last"`,
          },
        })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByStates(['open'], null),
    )

    expect(issues.map((issue) => issue.id)).toEqual(['1', '2', '3'])
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true)
    expect(fetchMock.mock.calls.slice(0, 2).map(([input]) => requestUrl(input))).toEqual([
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
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'], null)),
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
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'], null)),
    )

    expect(error.category).toBe('tracker_pagination')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('GitHub native issue dependencies', (): void => {
  it('skips dependency hydration when the caller requests issue metadata only', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> => Response.json([githubIssue(1)]))
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByStates(['closed'], null, {
        hydrateDependencies: false,
      }),
    )

    expect(issues).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('skips dependency hydration for metadata-only issue ID refreshes', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> => Response.json(githubIssue(1)))
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByIds([issueId('1')], {
        hydrateDependencies: false,
      }),
    )

    expect(issues).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('hydrates only dispatch candidates for scheduler list requests', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = requestUrl(input)
      return url.includes('/dependencies/blocked_by')
        ? Response.json([])
        : Response.json([githubIssue(1, ['symphony']), githubIssue(2)])
    })
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByStates(['open'], ['symphony']),
    )

    expect(issues).toHaveLength(2)
    expect(
      fetchMock.mock.calls
        .map(([input]) => requestUrl(input))
        .filter((url) => url.includes('/dependencies/blocked_by')),
    ).toEqual([
      'https://api.example.test/repos/example/symphony/issues/1/dependencies/blocked_by?per_page=100',
    ])
  })

  it('caches console dependency hydration between backlog refreshes', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      requestUrl(input).includes('/dependencies/blocked_by')
        ? Response.json([githubDependency(2)])
        : Response.json([githubIssue(1)]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const tracker = makeGitHubTracker(provider)

    await Effect.runPromise(tracker.fetchIssuesByStates(['open'], null))
    const [second] = await Effect.runPromise(tracker.fetchIssuesByStates(['open'], null))

    expect(second?.blockedBy).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('bypasses the dependency cache for issue ID refreshes', async (): Promise<void> => {
    let dependencyFetches = 0
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = requestUrl(input)
      if (url.endsWith('/issues/2')) {
        return Response.json(githubIssue(2))
      }
      dependencyFetches += 1
      return Response.json([githubDependency(3, dependencyFetches === 1 ? 'closed' : 'open')])
    })
    vi.stubGlobal('fetch', fetchMock)
    const tracker = makeGitHubTracker(provider)

    await Effect.runPromise(tracker.fetchIssuesByIds([issueId('2')]))
    const [refreshed] = await Effect.runPromise(tracker.fetchIssuesByIds([issueId('2')]))

    expect(refreshed?.blockedBy[0]?.state).toBe('open')
    expect(dependencyFetches).toBe(2)
  })

  it('decodes blockers and follows dependency pagination', async (): Promise<void> => {
    const next =
      'https://api.example.test/repos/example/symphony/issues/2/dependencies/blocked_by?per_page=100&page=2'
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = requestUrl(input)
        if (url.endsWith('/issues/2')) {
          return Response.json(githubIssue(2))
        }
        if (url === next) {
          return Response.json([githubDependency(4, 'closed')])
        }
        expect(new Headers(init?.headers).get('X-GitHub-Api-Version')).toBe('2026-03-10')
        return Response.json([githubDependency(3)], { headers: { Link: `<${next}>; rel="next"` } })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    const [issue] = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByIds([issueId('2')]),
    )

    expect(issue?.blockedBy).toEqual([
      {
        id: '10003',
        identifier: 'example/symphony#3',
        title: 'Blocker 3',
        state: 'open',
        url: 'https://example.test/issues/3',
      },
      {
        id: '10004',
        identifier: 'example/symphony#4',
        title: 'Blocker 4',
        state: 'closed',
        url: 'https://example.test/issues/4',
      },
    ])
  })

  it.each([
    ['missing state', { ...githubDependency(3), state: undefined }],
    ['malformed id', { ...githubDependency(3), id: 'not-a-number' }],
    ['missing repository', { ...githubDependency(3), repository_url: undefined }],
  ])('fails conservatively for %s', async (_name, dependency): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      requestUrl(input).endsWith('/issues/2')
        ? Response.json(githubIssue(2))
        : Response.json([dependency]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByIds([issueId('2')])),
    )

    expect(error.category).toBe('tracker_response')
    expect(error.retryable).toBe(false)
  })

  it('preserves useful dependency API errors', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      requestUrl(input).endsWith('/issues/2')
        ? Response.json(githubIssue(2))
        : new Response(null, { status: 503 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByIds([issueId('2')])),
    )

    expect(error.category).toBe('tracker_status')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('503')
  })
})

const githubPullRequest = (number: number): JsonObject => ({
  ...githubIssue(number),
  pull_request: { url: `https://api.example.test/repos/example/symphony/pulls/${String(number)}` },
})

const captureLogs = async <Value>(
  effect: Effect.Effect<Value, unknown>,
): Promise<Readonly<{ value: Value; logs: readonly string[] }>> => {
  const logs: string[] = []
  const logger = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ message }: Readonly<{ message: unknown }>) => {
      logs.push(JSON.stringify(message))
    }),
  )
  const value = await Effect.runPromise(
    (effect as Effect.Effect<Value, never>).pipe(Effect.provide(logger)),
  )
  return { value, logs }
}

describe('GitHub tracker state-list contract', (): void => {
  it('performs no request for an empty state list', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> => Response.json([]))
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByStates([], null),
    )

    expect(issues).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns non-dispatchable records so filtering stays in the orchestrator', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      requestUrl(input).includes('/dependencies/blocked_by')
        ? Response.json([])
        : Response.json([githubIssue(1), githubPullRequest(2)]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByStates(['open'], null),
    )

    expect(issues.map((issue) => [issue.id, issue.dispatchable])).toEqual([
      ['1', true],
      ['2', false],
    ])
    expect(
      fetchMock.mock.calls
        .map(([input]) => requestUrl(input))
        .filter((url) => url.includes('/dependencies/blocked_by')),
    ).toEqual([
      'https://api.example.test/repos/example/symphony/issues/1/dependencies/blocked_by?per_page=100',
    ])
  })

  it('keeps valid records and logs malformed ones from a mixed page', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      requestUrl(input).includes('/dependencies/blocked_by')
        ? Response.json([])
        : Response.json([
            githubIssue(1),
            { ...githubIssue(2), node_id: undefined },
            'not-an-object',
            githubIssue(3),
          ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { value, logs } = await captureLogs(
      makeGitHubTracker(provider).fetchIssuesByStates(['open'], null),
    )

    expect(value.map((issue) => issue.id)).toEqual(['1', '3'])
    expect(logs.some((entry) => entry.includes('malformed records'))).toBe(true)
    expect(logs.some((entry) => entry.includes('"skipped":2'))).toBe(true)
  })

  it('fails a scoped read that never stops paginating', async (): Promise<void> => {
    let page = 0
    const fetchMock = vi.fn(async (): Promise<Response> => {
      page += 1
      return Response.json([githubIssue(page)], {
        headers: {
          Link: `<https://api.example.test/repos/example/symphony/issues?state=open&per_page=100&page=${String(page + 1)}>; rel="next"`,
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'], null)),
    )

    expect(error.category).toBe('tracker_pagination')
    expect(error.message).toContain('100 pages')
  })
})

describe('GitHub tracker identity refresh contract', (): void => {
  it('performs no request for an empty id list', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> => Response.json([]))
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(makeGitHubTracker(provider).fetchIssuesByIds([]))

    expect(issues).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats requested identifiers as a set and returns one snapshot per id', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      requestUrl(input).includes('/dependencies/blocked_by')
        ? Response.json([])
        : Response.json(githubIssue(7)),
    )
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByIds([issueId('7'), issueId('7'), issueId('7')]),
    )

    expect(issues.map((issue) => issue.id)).toEqual(['7'])
    expect(
      fetchMock.mock.calls
        .map(([input]) => requestUrl(input))
        .filter((url) => url.endsWith('/issues/7')),
    ).toHaveLength(1)
  })

  it('fails a malformed requested record instead of dropping it', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      Response.json({ ...githubIssue(7), state: '' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByIds([issueId('7')])),
    )

    expect(error.category).toBe('tracker_response')
    expect(error.retryable).toBe(false)
  })
})

describe('GitHub tracker normalization', (): void => {
  it('normalizes required, nullable and collection fields', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      requestUrl(input).includes('/dependencies/blocked_by')
        ? Response.json([])
        : Response.json({
            ...githubIssue(11),
            body: 'Body text',
            html_url: '',
            assignee: { login: '' },
            labels: [{ name: ' Symphony ' }, 'SYMPHONY', { name: null }, { name: 'priority:2' }, 3],
            created_at: 'not-a-date',
            updated_at: '2026-01-02T00:00:00.000Z',
          }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const [issue] = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByIds([issueId('11')]),
    )

    expect(issue).toEqual({
      id: '11',
      nativeRef: {
        node_id: 'node-11',
        issue_number: 11,
        owner: 'example',
        repository: 'symphony',
      },
      identifier: 'example/symphony#11',
      title: 'Issue 11',
      description: 'Body text',
      priority: 2,
      state: 'open',
      branchName: null,
      url: null,
      assigneeId: null,
      labels: ['symphony', 'priority:2'],
      blockedBy: [],
      dispatchable: true,
      createdAt: null,
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    })
  })

  it('keeps the provider scope in dispatch and native identity', async (): Promise<void> => {
    const scoped = { ...provider, owner: 'other', repository: 'fork' }
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      requestUrl(input).includes('/dependencies/blocked_by')
        ? Response.json([])
        : Response.json(githubIssue(5)),
    )
    vi.stubGlobal('fetch', fetchMock)

    const [issue] = await Effect.runPromise(
      makeGitHubTracker(scoped).fetchIssuesByIds([issueId('5')]),
    )

    expect(issue?.identifier).toBe('other/fork#5')
    expect(issue?.nativeRef).toEqual({
      node_id: 'node-5',
      issue_number: 5,
      owner: 'other',
      repository: 'fork',
    })
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] ?? '')).toBe(
      'https://api.example.test/repos/other/fork/issues/5',
    )
  })
})

describe('GitHub tracker error mapping', (): void => {
  it('maps a secondary rate limit with Retry-After seconds', async (): Promise<void> => {
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Response(null, { status: 429, headers: { 'Retry-After': '30' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'], null)),
    )

    expect(error.category).toBe('tracker_rate_limited')
    expect(error.retryable).toBe(true)
    expect(error.retryAfterMs).toBe(30_000)
  })

  it('maps a primary rate limit from the reset header', async (): Promise<void> => {
    const reset = Math.floor(Date.now() / 1_000) + 60
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Response(null, {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'], null)),
    )

    expect(error.category).toBe('tracker_rate_limited')
    expect(error.retryAfterMs).toBeGreaterThan(58_000)
    expect(error.retryAfterMs).toBeLessThanOrEqual(60_000)
  })

  it('keeps an ordinary forbidden response as a non-retryable status failure', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> => new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'], null)),
    )

    expect(error.category).toBe('tracker_status')
    expect(error.retryable).toBe(false)
    expect(error.retryAfterMs).toBeUndefined()
  })

  it('maps a transport failure to a retryable request failure', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new TypeError('network unreachable')
    })
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'], null)),
    )

    expect(error.category).toBe('tracker_request')
    expect(error.retryable).toBe(true)
  })

  it('maps an undecodable body to a non-retryable response failure', async (): Promise<void> => {
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'], null)),
    )

    expect(error.category).toBe('tracker_response')
    expect(error.retryable).toBe(false)
  })
})

describe('GitHub tracker dependency hydration selection', (): void => {
  it('hydrates nothing for an empty dependency label list', async (): Promise<void> => {
    const fetchMock = vi.fn(async (_input: string | URL | Request): Promise<Response> =>
      Response.json([githubIssue(1, ['symphony'])]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByStates(['closed'], []),
    )

    expect(issues.map((issue) => issue.blockedBy)).toEqual([[]])
    expect(
      fetchMock.mock.calls
        .map(([input]) => requestUrl(input))
        .filter((url) => url.includes('/dependencies/blocked_by')),
    ).toEqual([])
  })
})
