import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { runAgent } from '../../src/adapters/codex/codex.js'
import { issueId, issueIdentifier, type Issue } from '../../src/domain/domain.js'
import { makeGitHubTracker } from '../../src/adapters/github/issues.js'
import { githubProviderDefaults } from '../../src/config/tracker-config.js'
import type { CodexConfig } from '../../src/config/workflow.js'

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
const githubMissing = [
  repository === undefined ? 'SYMPHONY_INTEGRATION_REPOSITORY' : null,
  githubToken === undefined ? 'GITHUB_TOKEN' : null,
].filter((name): name is string => name !== null)
const codexMissing = [
  codexToken === undefined ? 'OPENAI_API_KEY or CODEX_ACCESS_TOKEN' : null,
].filter((name): name is string => name !== null)

const githubIntegration = githubMissing.length === 0 ? it : it.skip
const codexIntegration = codexMissing.length === 0 ? it : it.skip

describe('Real GitHub/Codex Integration Profile', (): void => {
  if (enabledInCi && githubMissing.length > 0) {
    it('has every GitHub credential required by the explicitly enabled CI profile', (): void => {
      expect(
        githubMissing,
        `missing GitHub integration credentials: ${githubMissing.join(', ')}`,
      ).toEqual([])
    })
  } else if (githubMissing.length > 0) {
    it.skip(`GitHub credentials unavailable: ${githubMissing.join(', ')}`, (): void => {})
  }

  if (enabledInCi && codexMissing.length > 0) {
    it('has every Codex credential required by the explicitly enabled CI profile', (): void => {
      expect(
        codexMissing,
        `missing Codex integration credentials: ${codexMissing.join(', ')}`,
      ).toEqual([])
    })
  } else if (codexMissing.length > 0) {
    it.skip(`Codex credentials unavailable: ${codexMissing.join(', ')}`, (): void => {})
  }

  githubIntegration(
    'authenticates against the isolated GitHub repository scope',
    async (): Promise<void> => {
      const selectedRepository = repository ?? ''
      const token = githubToken ?? ''
      const repositoryParts = selectedRepository.split('/')
      expect(repositoryParts).toHaveLength(2)
      const owner = repositoryParts[0] ?? ''
      const repositoryName = repositoryParts[1] ?? ''
      expect(owner.length).toBeGreaterThan(0)
      expect(repositoryName.length).toBeGreaterThan(0)
      const tracker = makeGitHubTracker({
        owner,
        repository: repositoryName,
        token,
        tokenEnvironmentName: 'GITHUB_TOKEN',
        apiBaseUrl: githubProviderDefaults.apiBaseUrl,
        baseBranch: githubProviderDefaults.baseBranch,
      })
      const issues = await Effect.runPromise(
        tracker.fetchIssuesByStates(['open'], null, { hydrateDependencies: false }),
      )
      expect(Array.isArray(issues)).toBe(true)
    },
  )

  codexIntegration(
    'runs Codex in a disposable isolated workspace and always cleans it',
    async (): Promise<void> => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-real-integration-'))
      const identifier = `real-integration-${process.pid}-${Date.now().toString(36)}`
      const workspacePath = join(workspaceRoot, identifier)
      await mkdir(workspacePath)
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
            workspace: { path: workspacePath, key: identifier, createdNow: true },
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
