import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { issueId, issueIdentifier, type Issue } from '../src/domain.js'
import { loadWorkflow, renderPrompt } from '../src/workflow.js'

const temporaryDirectories: string[] = []

const makeTemporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'symphony-workflow-test-'))
  temporaryDirectories.push(path)
  return path
}

const issue: Issue = {
  id: issueId('42'),
  nativeRef: { number: 42 },
  identifier: issueIdentifier('GH-42'),
  title: 'Keep types exact',
  description: 'Use the type system',
  priority: 1,
  state: 'open',
  branchName: null,
  url: 'https://example.test/issues/42',
  assigneeId: null,
  labels: ['symphony'],
  blockedBy: [],
  dispatchable: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: null,
}

afterEach(async (): Promise<void> => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('workflow loading', (): void => {
  it('resolves strict configuration and renders issue data', async (): Promise<void> => {
    const directory = await makeTemporaryDirectory()
    const path = join(directory, 'WORKFLOW.md')
    await writeFile(
      path,
      `---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TEST_TRACKER_TOKEN
  required_labels: [Symphony]
workspace:
  root: .workspaces
agent:
  max_concurrent_agents: 2
---
Work on {{ issue.identifier }}: {{ issue.title }} (attempt {{ attempt }})
`,
    )

    const workflow = await Effect.runPromise(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' }))
    const prompt = await Effect.runPromise(renderPrompt(workflow, issue, 3))

    expect(workflow.config.tracker.provider.token).toBe('secret')
    expect(workflow.config.tracker.requiredLabels).toEqual(['symphony'])
    expect(workflow.config.tracker.provider.baseBranch).toBe('main')
    expect(workflow.config.workspaceRoot).toBe(join(directory, '.workspaces'))
    expect(workflow.config.agent.maxConcurrentAgents).toBe(2)
    expect(workflow.config.codex.threadSandbox).toBe('workspace-write')
    expect(prompt).toBe('Work on GH-42: Keep types exact (attempt 3)')
  })

  it('rejects a missing environment indirection', async (): Promise<void> => {
    const directory = await makeTemporaryDirectory()
    const path = join(directory, 'WORKFLOW.md')
    await writeFile(
      path,
      `---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $MISSING_TRACKER_TOKEN
---
Do the work
`,
    )

    const error = await Effect.runPromise(Effect.flip(loadWorkflow(path, {})))

    expect(error.category).toBe('invalid_config')
  })

  it('accepts port zero for an ephemeral operator server', async (): Promise<void> => {
    const directory = await makeTemporaryDirectory()
    const path = join(directory, 'WORKFLOW.md')
    await writeFile(
      path,
      `---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: token
server:
  port: 0
---
Do the work
`,
    )

    const workflow = await Effect.runPromise(loadWorkflow(path, {}))

    expect(workflow.config.serverPort).toBe(0)
  })
})
