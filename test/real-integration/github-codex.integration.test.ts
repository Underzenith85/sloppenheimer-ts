import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { runAgent } from '../../src/codex.js'
import { issueId, issueIdentifier, type Issue } from '../../src/domain.js'
import type { CodexConfig } from '../../src/workflow.js'

const environment = process.env
const nonEmptyEnvironmentValue = (name: string): string | undefined => {
  const value = environment[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

const enabledInCi = environment['CI'] === 'true' && environment['SYMPHONY_REAL_INTEGRATION'] === '1'
const repository = nonEmptyEnvironmentValue('SYMPHONY_INTEGRATION_REPOSITORY')
const githubToken = nonEmptyEnvironmentValue('GITHUB_TOKEN')
const codexToken =
  nonEmptyEnvironmentValue('OPENAI_API_KEY') ?? nonEmptyEnvironmentValue('CODEX_ACCESS_TOKEN')
const missing = [
  repository === undefined ? 'SYMPHONY_INTEGRATION_REPOSITORY' : null,
  githubToken === undefined ? 'GITHUB_TOKEN' : null,
  codexToken === undefined ? 'OPENAI_API_KEY or CODEX_ACCESS_TOKEN' : null,
].filter((name): name is string => name !== null)

const integration = missing.length === 0 ? it : it.skip

describe('Real GitHub/Codex Integration Profile', (): void => {
  if (enabledInCi && missing.length > 0) {
    it('has every credential required by the explicitly enabled CI profile', (): void => {
      expect(missing, `missing integration credentials: ${missing.join(', ')}`).toEqual([])
    })
  } else if (missing.length > 0) {
    it.skip(`credentials unavailable: ${missing.join(', ')}`, (): void => {})
  }

  integration(
    'authenticates against the isolated GitHub repository scope',
    async (): Promise<void> => {
      const selectedRepository = repository ?? ''
      const token = githubToken ?? ''
      const response = await fetch(`https://api.github.com/repos/${selectedRepository}`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'symphony-ts-real-integration',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(30_000),
      })
      expect(response.status).toBe(200)
      const payload = (await response.json()) as unknown
      expect(payload).toMatchObject({ full_name: selectedRepository })
    },
  )

  integration(
    'runs Codex in a disposable isolated workspace and always cleans it',
    async (): Promise<void> => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-real-integration-'))
      const identifier = `real-integration-${process.pid}-${Date.now().toString(36)}`
      const issue: Issue = {
        id: issueId(identifier),
        nativeRef: null,
        identifier: issueIdentifier(identifier),
        title: 'Real integration smoke test',
        description: null,
        priority: null,
        state: 'open',
        branchName: null,
        url: null,
        assigneeId: null,
        labels: [],
        blockedBy: [],
        dispatchable: true,
        createdAt: null,
        updatedAt: null,
      }
      const config: CodexConfig = {
        command: environment['SYMPHONY_INTEGRATION_CODEX_COMMAND'] ?? 'codex app-server',
        approvalPolicy: 'never',
        threadSandbox: 'workspace-write',
        turnSandboxPolicy: null,
        turnTimeoutMs: 90_000,
        readTimeoutMs: 10_000,
        stallTimeoutMs: 30_000,
      }
      try {
        const result = await Effect.runPromise(
          runAgent({
            issue,
            workspace: { path: workspaceRoot, key: identifier, createdNow: true },
            workspaceRoot,
            config,
            prompt: 'This is an integration smoke test. Reply briefly without changing files.',
            maxTurns: 1,
            secretEnvironmentNames: ['GITHUB_TOKEN', 'GH_TOKEN'],
            refreshIssue: () => Effect.succeed(null),
            isRoutable: () => false,
            onEvent: () => {},
          }),
        )
        expect(result.threadId.length).toBeGreaterThan(0)
        expect(result.turnId.length).toBeGreaterThan(0)
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true })
      }
    },
  )
})
