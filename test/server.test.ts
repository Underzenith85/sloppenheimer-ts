import { Effect } from 'effect'
import { request } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import { issueId } from '../src/domain.js'
import type { OperatorBackend } from '../src/operator.js'
import type { OrchestratorSnapshot } from '../src/orchestrator.js'
import { startOperatorServer } from '../src/server.js'

const snapshot: OrchestratorSnapshot = {
  generatedAt: '2026-08-29T12:00:00.000Z',
  workflowPath: '/tmp/WORKFLOW.md',
  effectiveWorkflow: {
    fingerprint: 'valid-workflow',
    loadedAt: '2026-08-29T11:00:00.000Z',
  },
  workflowReloadError: null,
  pollingIntervalMs: 10_000,
  maxConcurrentAgents: 2,
  counts: { running: 1, retrying: 0, completed: 3 },
  running: [
    {
      issueId: issueId('17'),
      identifier: 'example/symphony#17',
      title: 'Operator console',
      url: 'https://github.com/example/symphony/issues/17',
      attempt: null,
      startedAt: '2026-08-29T11:59:00.000Z',
      lastEventAt: null,
      lastEvent: null,
      processId: 42,
      tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      workerHost: 'local',
    },
  ],
  retrying: [],
  totals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 60 },
  rateLimits: null,
}

const makeBackend = (setIssueEnabled = vi.fn()): OperatorBackend => ({
  snapshot: Effect.succeed(snapshot),
  refresh: Effect.void,
  backlog: Effect.succeed({
    controlLabel: 'symphony',
    issues: [
      {
        number: 17,
        identifier: 'example/symphony#17',
        title: 'Operator console',
        url: 'https://github.com/example/symphony/issues/17',
        labels: ['symphony'],
        priority: 1,
        createdAt: '2026-08-29T10:00:00.000Z',
        enabled: true,
      },
    ],
  }),
  setIssueEnabled: (number, enabled) =>
    Effect.sync(() => {
      setIssueEnabled(number, enabled)
    }),
})

const withServer = <Value>(
  backend: OperatorBackend,
  use: (url: string) => Promise<Value>,
): Promise<Value> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startOperatorServer(0, backend)
        return yield* Effect.promise(() => use(server.url))
      }),
    ),
  )

describe('operator server', (): void => {
  it('serves the console and versioned runtime state on loopback', async (): Promise<void> => {
    await withServer(makeBackend(), async (url) => {
      const page = await fetch(url)
      const state = await fetch(`${url}/api/v1/state`)

      expect(page.status).toBe(200)
      expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
      expect(await page.text()).toContain('Conduct the work.')
      expect(state.status).toBe(200)
      expect(await state.json()).toMatchObject({ counts: { running: 1 }, maxConcurrentAgents: 2 })
    })
  })

  it('requires its page token before changing issue eligibility', async (): Promise<void> => {
    const setIssueEnabled = vi.fn()
    await withServer(makeBackend(setIssueEnabled), async (url) => {
      const rejected = await fetch(`${url}/api/v1/issues/17/pause`, { method: 'POST' })
      expect(rejected.status).toBe(403)

      const page = await (await fetch(url)).text()
      const token = /name="csrf-token" content="([^"]+)"/u.exec(page)?.[1]
      expect(token).toBeDefined()
      const accepted = await fetch(`${url}/api/v1/issues/17/pause`, {
        method: 'POST',
        headers: { 'X-Symphony-CSRF': token ?? '' },
      })

      expect(accepted.status).toBe(202)
      expect(setIssueEnabled).toHaveBeenCalledWith(17, false)
    })
  })

  it('returns explicit 404 and 405 responses', async (): Promise<void> => {
    await withServer(makeBackend(), async (url) => {
      const missing = await fetch(`${url}/missing`)
      const wrongMethod = await fetch(`${url}/api/v1/state`, { method: 'POST' })

      expect(missing.status).toBe(404)
      expect(wrongMethod.status).toBe(405)
      expect(wrongMethod.headers.get('allow')).toBe('GET')
    })
  })

  it('rejects non-loopback host headers', async (): Promise<void> => {
    await withServer(makeBackend(), async (url) => {
      const target = new URL(url)
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = request(
          {
            hostname: target.hostname,
            port: target.port,
            headers: { Host: 'attacker.example' },
          },
          (response) => {
            response.resume()
            resolve(response.statusCode ?? 0)
          },
        )
        outgoing.once('error', reject)
        outgoing.end()
      })

      expect(status).toBe(421)
    })
  })
})
