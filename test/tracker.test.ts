import { it } from '@effect/vitest'
import { Clock, Effect, Logger, Redacted } from 'effect'
import { afterEach, describe, expect, vi } from 'vitest'

import { issueId, type JsonObject } from '@symphony/core/domain/domain.js'
import { makeGitHubIssueControl, makeGitHubTracker } from '@symphony/adapter-github/issues.js'
import type { IssueControlPort } from '@symphony/core/ports/issue-control.js'
import type { TrackerPort } from '@symphony/core/ports/tracker.js'
import type { GitHubProviderConfig } from '@symphony/adapter-github'

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'symphony',
  token: Redacted.make('secret'),
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

/**
 * Tracker construction is an effect only because it allocates the dependency cache `Ref`, so it
 * is yielded in the test's own fiber rather than run out to a value.
 */
const trackerOf = (config: GitHubProviderConfig = provider): Effect.Effect<TrackerPort> =>
  makeGitHubTracker(config)

const issueControlOf = (config: GitHubProviderConfig = provider): Effect.Effect<IssueControlPort> =>
  makeGitHubIssueControl(config)

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
  it.effect('declares the configured secret variable and all fallback aliases', () =>
    Effect.gen(function* () {
      expect((yield* trackerOf(provider)).secretEnvironmentNames).toEqual([
        'CUSTOM_GITHUB_TOKEN',
        'GITHUB_TOKEN',
        'GH_TOKEN',
      ])
    }),
  )

  it.effect('deduplicates a configured fallback alias', () =>
    Effect.gen(function* () {
      expect(
        (yield* trackerOf({ ...provider, tokenEnvironmentName: 'GH_TOKEN' }))
          .secretEnvironmentNames,
      ).toEqual(['GH_TOKEN', 'GITHUB_TOKEN'])
    }),
  )
})

describe('GitHub tracker pagination', (): void => {
  it.effect('combines all pages and removes duplicate issues', () =>
    Effect.gen(function* () {
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

      const issues = yield* (yield* trackerOf(provider)).fetchIssuesByStates(['open'], null)

      expect(issues.map((issue) => issue.id)).toEqual(['1', '2', '3'])
      expect(fetchMock).toHaveBeenCalledTimes(5)
      expect(fetchMock.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(
        true,
      )
      expect(fetchMock.mock.calls.slice(0, 2).map(([input]) => requestUrl(input))).toEqual([
        'https://api.example.test/repos/example/symphony/issues?state=open&per_page=100',
        secondPageUrl,
      ])
    }),
  )

  it.effect('preserves response decoding errors from later pages', () =>
    Effect.gen(function* () {
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

      const error = yield* Effect.flip(
        (yield* trackerOf(provider)).fetchIssuesByStates(['open'], null),
      )

      expect(error.category).toBe('tracker_response')
      expect(error.retryable).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }),
  )

  it.effect('does not send the tracker token to a different origin', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (): Promise<Response> =>
        Response.json([githubIssue(1)], {
          headers: { Link: '<https://attacker.example.test/issues?page=2>; rel="next"' },
        }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const error = yield* Effect.flip(
        (yield* trackerOf(provider)).fetchIssuesByStates(['open'], null),
      )

      expect(error.category).toBe('tracker_pagination')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }),
  )
})

describe('GitHub native issue dependencies', (): void => {
  it.effect('skips dependency hydration when the caller requests issue metadata only', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (): Promise<Response> => Response.json([githubIssue(1)]))
      vi.stubGlobal('fetch', fetchMock)

      const issues = yield* (yield* trackerOf(provider)).fetchIssuesByStates(['closed'], null, {
        hydrateDependencies: false,
      })

      expect(issues).toHaveLength(1)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }),
  )

  it.effect('skips dependency hydration for metadata-only issue ID refreshes', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (): Promise<Response> => Response.json(githubIssue(1)))
      vi.stubGlobal('fetch', fetchMock)

      const issues = yield* (yield* trackerOf(provider)).fetchIssuesByIds([issueId('1')], {
        hydrateDependencies: false,
      })

      expect(issues).toHaveLength(1)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }),
  )

  it.effect('hydrates only dispatch candidates for scheduler list requests', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url = requestUrl(input)
        return url.includes('/dependencies/blocked_by')
          ? Response.json([])
          : Response.json([githubIssue(1, ['symphony']), githubIssue(2)])
      })
      vi.stubGlobal('fetch', fetchMock)

      const issues = yield* (yield* trackerOf(provider)).fetchIssuesByStates(['open'], ['symphony'])

      expect(issues).toHaveLength(2)
      expect(
        fetchMock.mock.calls
          .map(([input]) => requestUrl(input))
          .filter((url) => url.includes('/dependencies/blocked_by')),
      ).toEqual([
        'https://api.example.test/repos/example/symphony/issues/1/dependencies/blocked_by?per_page=100',
      ])
    }),
  )

  it.effect('caches console dependency hydration between backlog refreshes', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
        requestUrl(input).includes('/dependencies/blocked_by')
          ? Response.json([githubDependency(2)])
          : Response.json([githubIssue(1)]),
      )
      vi.stubGlobal('fetch', fetchMock)
      const tracker = yield* trackerOf(provider)

      yield* tracker.fetchIssuesByStates(['open'], null)
      const [second] = yield* tracker.fetchIssuesByStates(['open'], null)

      expect(second?.blockedBy).toHaveLength(1)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    }),
  )

  it.effect('leaves one coherent cache entry when the same issue hydrates concurrently', () =>
    Effect.gen(function* () {
      let dependencyRequests = 0
      let openGate: () => void = (): void => {}
      // Neither dependency response lands until both requests are in flight, so both hydrations are
      // guaranteed to miss the cache and race to write it.
      const bothInFlight = new Promise<void>((resolve): void => {
        openGate = resolve
      })
      const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
        if (!requestUrl(input).includes('/dependencies/blocked_by')) {
          return Response.json([githubIssue(1)])
        }
        dependencyRequests += 1
        const blocker = githubDependency(dependencyRequests === 1 ? 2 : 3)
        if (dependencyRequests >= 2) {
          openGate()
        }
        await bothInFlight
        return Response.json([blocker])
      })
      vi.stubGlobal('fetch', fetchMock)
      const tracker = yield* trackerOf(provider)

      yield* Effect.all(
        [tracker.fetchIssuesByStates(['open'], null), tracker.fetchIssuesByStates(['open'], null)],
        { concurrency: 2 },
      )
      const [cached] = yield* tracker.fetchIssuesByStates(['open'], null)

      // Both writers ran, the third refresh read the cache instead of the API, and what it read is
      // one writer's entry whole rather than a blend of the two.
      expect(dependencyRequests).toBe(2)
      expect(cached?.blockedBy).toHaveLength(1)
      expect(['Blocker 2', 'Blocker 3']).toContain(cached?.blockedBy[0]?.title)
    }),
  )

  it.effect('bypasses the dependency cache for issue ID refreshes', () =>
    Effect.gen(function* () {
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
      const tracker = yield* trackerOf(provider)

      const [initial] = yield* tracker.fetchIssuesByIds([issueId('2')])
      const [refreshed] = yield* tracker.fetchIssuesByIds([issueId('2')])

      expect(initial?.dispatchable).toBe(true)
      expect(refreshed?.blockedBy[0]?.state).toBe('open')
      expect(refreshed?.dispatchable).toBe(false)
      expect(dependencyFetches).toBe(2)
    }),
  )

  it.effect('decodes blockers and follows dependency pagination', () =>
    Effect.gen(function* () {
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
          return Response.json([githubDependency(3)], {
            headers: { Link: `<${next}>; rel="next"` },
          })
        },
      )
      vi.stubGlobal('fetch', fetchMock)

      const [issue] = yield* (yield* trackerOf(provider)).fetchIssuesByIds([issueId('2')])

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
      expect(issue?.dispatchable).toBe(false)
    }),
  )

  it.effect(
    'derives cycle eligibility in the adapter while returning every state-list record',
    () =>
      Effect.gen(function* () {
        const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
          const url = requestUrl(input)
          if (url.includes('/issues/1/dependencies/blocked_by')) {
            return Response.json([githubDependency(2)])
          }
          if (url.includes('/issues/2/dependencies/blocked_by')) {
            return Response.json([githubDependency(1)])
          }
          return Response.json([githubIssue(1), githubIssue(2)])
        })
        vi.stubGlobal('fetch', fetchMock)

        const issues = yield* (yield* trackerOf(provider)).fetchIssuesByStates(['open'], null)

        expect(issues.map((issue) => [issue.id, issue.dispatchable])).toEqual([
          ['1', false],
          ['2', false],
        ])
        expect(issues.every((issue) => issue.blockedBy.length === 1)).toBe(true)
      }),
  )

  it.effect.each([
    ['missing state', { ...githubDependency(3), state: undefined }],
    ['malformed id', { ...githubDependency(3), id: 'not-a-number' }],
    ['missing repository', { ...githubDependency(3), repository_url: undefined }],
  ] as const)('fails conservatively for %s', ([, dependency]) =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
        requestUrl(input).endsWith('/issues/2')
          ? Response.json(githubIssue(2))
          : Response.json([dependency]),
      )
      vi.stubGlobal('fetch', fetchMock)

      const tracker = yield* trackerOf(provider)
      const error = yield* Effect.flip(tracker.fetchIssuesByIds([issueId('2')]))

      expect(error.category).toBe('tracker_response')
      expect(error.retryable).toBe(false)
    }),
  )

  it.effect('preserves useful dependency API errors', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
        requestUrl(input).endsWith('/issues/2')
          ? Response.json(githubIssue(2))
          : new Response(null, { status: 503 }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const error = yield* Effect.flip(
        (yield* trackerOf(provider)).fetchIssuesByIds([issueId('2')]),
      )

      expect(error.category).toBe('tracker_status')
      expect(error.retryable).toBe(true)
      expect(error.message).toContain('503')
    }),
  )
})

const githubPullRequest = (number: number): JsonObject => ({
  ...githubIssue(number),
  pull_request: { url: `https://api.example.test/repos/example/symphony/pulls/${String(number)}` },
})

/** Runs the effect against a collecting logger, so a test can assert on what it reported. */
const captureLogs = <Value>(
  effect: Effect.Effect<Value, unknown>,
): Effect.Effect<Readonly<{ value: Value; logs: readonly string[] }>> => {
  const logs: string[] = []
  const logger = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ message }: Readonly<{ message: unknown }>) => {
      logs.push(JSON.stringify(message))
    }),
  )
  return (effect as Effect.Effect<Value, never>)
    .pipe(Effect.provide(logger))
    .pipe(Effect.map((value) => ({ value, logs })))
}

describe('GitHub tracker state-list contract', (): void => {
  it.effect('performs no request for an empty state list', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (): Promise<Response> => Response.json([]))
      vi.stubGlobal('fetch', fetchMock)

      const issues = yield* (yield* trackerOf(provider)).fetchIssuesByStates([], null)

      expect(issues).toEqual([])
      expect(fetchMock).not.toHaveBeenCalled()
    }),
  )

  it.effect('returns non-dispatchable records so filtering stays in the orchestrator', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
        requestUrl(input).includes('/dependencies/blocked_by')
          ? Response.json([])
          : Response.json([githubIssue(1), githubPullRequest(2)]),
      )
      vi.stubGlobal('fetch', fetchMock)

      const issues = yield* (yield* trackerOf(provider)).fetchIssuesByStates(['open'], null)

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
    }),
  )

  it.effect('keeps blocked issues in the operator backlog while excluding pull requests', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url = requestUrl(input)
        if (url.includes('/issues/1/dependencies/blocked_by')) {
          return Response.json([githubDependency(2)])
        }
        if (url.includes('/dependencies/blocked_by')) {
          return Response.json([])
        }
        return Response.json([githubIssue(1), githubIssue(2), githubPullRequest(3)])
      })
      vi.stubGlobal('fetch', fetchMock)

      const issues = yield* (yield* issueControlOf(provider)).listOpenIssues()

      expect(issues.map((issue) => [issue.id, issue.dispatchable])).toEqual([
        ['1', false],
        ['2', true],
      ])
      expect(issues[0]?.blockedBy).toHaveLength(1)
    }),
  )

  it.effect('keeps valid records and logs malformed ones from a mixed page', () =>
    Effect.gen(function* () {
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

      const { value, logs } = yield* captureLogs(
        (yield* trackerOf(provider)).fetchIssuesByStates(['open'], null),
      )

      expect(value.map((issue) => issue.id)).toEqual(['1', '3'])
      expect(logs.some((entry) => entry.includes('malformed records'))).toBe(true)
      expect(logs.some((entry) => entry.includes('"skipped":2'))).toBe(true)
    }),
  )

  it.effect('fails a scoped read that never stops paginating', () =>
    Effect.gen(function* () {
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

      const error = yield* Effect.flip(
        (yield* trackerOf(provider)).fetchIssuesByStates(['open'], null),
      )

      expect(error.category).toBe('tracker_pagination')
      expect(error.message).toContain('100 pages')
    }),
  )
})

describe('GitHub tracker identity refresh contract', (): void => {
  it.effect('performs no request for an empty id list', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (): Promise<Response> => Response.json([]))
      vi.stubGlobal('fetch', fetchMock)

      const issues = yield* (yield* trackerOf(provider)).fetchIssuesByIds([])

      expect(issues).toEqual([])
      expect(fetchMock).not.toHaveBeenCalled()
    }),
  )

  it.effect('treats requested identifiers as a set and returns one snapshot per id', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
        requestUrl(input).includes('/dependencies/blocked_by')
          ? Response.json([])
          : Response.json(githubIssue(7)),
      )
      vi.stubGlobal('fetch', fetchMock)

      const issues = yield* (yield* trackerOf(provider)).fetchIssuesByIds([
        issueId('7'),
        issueId('7'),
        issueId('7'),
      ])

      expect(issues.map((issue) => issue.id)).toEqual(['7'])
      expect(
        fetchMock.mock.calls
          .map(([input]) => requestUrl(input))
          .filter((url) => url.endsWith('/issues/7')),
      ).toHaveLength(1)
    }),
  )

  it.effect('fails a malformed requested record instead of dropping it', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (): Promise<Response> =>
        Response.json({ ...githubIssue(7), state: '' }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const error = yield* Effect.flip(
        (yield* trackerOf(provider)).fetchIssuesByIds([issueId('7')]),
      )

      expect(error.category).toBe('tracker_response')
      expect(error.retryable).toBe(false)
    }),
  )
})

describe('GitHub tracker normalization', (): void => {
  it.effect('normalizes required, nullable and collection fields', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
        requestUrl(input).includes('/dependencies/blocked_by')
          ? Response.json([])
          : Response.json({
              ...githubIssue(11),
              body: 'Body text',
              html_url: '',
              assignee: { login: '' },
              labels: [
                { name: ' Symphony ' },
                'SYMPHONY',
                { name: null },
                { name: 'priority:2' },
                3,
              ],
              created_at: 'not-a-date',
              updated_at: '2026-01-02T00:00:00.000Z',
            }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const [issue] = yield* (yield* trackerOf(provider)).fetchIssuesByIds([issueId('11')])

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
    }),
  )

  it.effect('keeps the provider scope in dispatch and native identity', () =>
    Effect.gen(function* () {
      const scoped = { ...provider, owner: 'other', repository: 'fork' }
      const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
        requestUrl(input).includes('/dependencies/blocked_by')
          ? Response.json([])
          : Response.json(githubIssue(5)),
      )
      vi.stubGlobal('fetch', fetchMock)

      const [issue] = yield* (yield* trackerOf(scoped)).fetchIssuesByIds([issueId('5')])

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
    }),
  )
})

describe('GitHub tracker error mapping', (): void => {
  it.effect('maps a secondary rate limit with Retry-After seconds', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(
        async (): Promise<Response> =>
          new Response(null, { status: 429, headers: { 'Retry-After': '30' } }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const error = yield* Effect.flip(
        (yield* trackerOf(provider)).fetchIssuesByStates(['open'], null),
      )

      expect(error.category).toBe('tracker_rate_limited')
      expect(error.retryable).toBe(true)
      expect(error.retryAfterMs).toBe(30_000)
    }),
  )

  it.effect('maps a primary rate limit from the reset header', () =>
    Effect.gen(function* () {
      // The adapter reads the instant it compares the reset against from the clock (#184), so the
      // header is dated from the same clock rather than from the ambient one.
      const reset = Math.floor((yield* Clock.currentTimeMillis) / 1_000) + 60
      const fetchMock = vi.fn(
        async (): Promise<Response> =>
          new Response(null, {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
          }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const error = yield* Effect.flip(
        (yield* trackerOf(provider)).fetchIssuesByStates(['open'], null),
      )

      expect(error.category).toBe('tracker_rate_limited')
      // Exact rather than a window: the header and the adapter now read the same clock, so
      // nothing drifts between them.
      expect(error.retryAfterMs).toBe(60_000)
    }),
  )

  it.effect('keeps an ordinary forbidden response as a non-retryable status failure', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (): Promise<Response> => new Response(null, { status: 403 }))
      vi.stubGlobal('fetch', fetchMock)

      const error = yield* Effect.flip(
        (yield* trackerOf(provider)).fetchIssuesByStates(['open'], null),
      )

      expect(error.category).toBe('tracker_status')
      expect(error.retryable).toBe(false)
      expect(error.retryAfterMs).toBeUndefined()
    }),
  )

  it.effect('maps a transport failure to a retryable request failure', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (): Promise<Response> => {
        throw new TypeError('network unreachable')
      })
      vi.stubGlobal('fetch', fetchMock)

      const error = yield* Effect.flip(
        (yield* trackerOf(provider)).fetchIssuesByStates(['open'], null),
      )

      expect(error.category).toBe('tracker_request')
      expect(error.retryable).toBe(true)
    }),
  )

  it.effect('maps an undecodable body to a non-retryable response failure', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(
        async (): Promise<Response> =>
          new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const error = yield* Effect.flip(
        (yield* trackerOf(provider)).fetchIssuesByStates(['open'], null),
      )

      expect(error.category).toBe('tracker_response')
      expect(error.retryable).toBe(false)
    }),
  )
})

describe('GitHub tracker dependency hydration selection', (): void => {
  it.effect('hydrates nothing for an empty dependency label list', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (_input: string | URL | Request): Promise<Response> =>
        Response.json([githubIssue(1, ['symphony'])]),
      )
      vi.stubGlobal('fetch', fetchMock)

      const issues = yield* (yield* trackerOf(provider)).fetchIssuesByStates(['closed'], [])

      expect(issues.map((issue) => issue.blockedBy)).toEqual([[]])
      expect(
        fetchMock.mock.calls
          .map(([input]) => requestUrl(input))
          .filter((url) => url.includes('/dependencies/blocked_by')),
      ).toEqual([])
    }),
  )
})
