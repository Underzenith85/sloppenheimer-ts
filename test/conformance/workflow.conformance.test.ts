import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { issueId, issueIdentifier, type Issue } from '../../src/domain/domain.js'
import { loadWorkflow, renderPrompt } from '../../src/config/workflow.js'

const directories: string[] = []
const writeWorkflow = async (source: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'symphony-workflow-conformance-'))
  directories.push(directory)
  const path = join(directory, 'WORKFLOW.md')
  await writeFile(path, source, 'utf8')
  return path
}

const issue: Issue = {
  id: issueId('19'),
  nativeRef: null,
  identifier: issueIdentifier('owner/repository#19'),
  title: 'Conformance',
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

afterEach(async (): Promise<void> => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('Core Conformance workflow errors and strict parsing', (): void => {
  it.each([
    ['invalid YAML', '---\ntracker: [unterminated\n---\nprompt', 'workflow_parse_error'],
    [
      'non-map front matter',
      '---\n- not\n- a\n- map\n---\nprompt',
      'workflow_front_matter_not_a_map',
    ],
  ] as const)('returns a typed error for %s', async (_name, source, category): Promise<void> => {
    const path = await writeWorkflow(source)
    const error = await Effect.runPromise(Effect.flip(loadWorkflow(path, {})))
    expect(error.category).toBe(category)
  })

  it('preserves shell commands and normalizes only valid per-state limits', async (): Promise<void> => {
    const path = await writeWorkflow(`---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TRACKER_TOKEN
agent:
  max_concurrent_agents_by_state:
    " Ready ": 2
    invalid: -1
    ignored: nope
codex:
  command: 'printf "$UNCHANGED" | codex app-server'
---
{{ issue.identifier }} {{ attempt }}
`)
    const workflow = await Effect.runPromise(loadWorkflow(path, { TRACKER_TOKEN: 'secret' }))
    expect(workflow.config.codex.command).toBe('printf "$UNCHANGED" | codex app-server')
    expect([...workflow.config.agent.maxConcurrentAgentsByState]).toEqual([['ready', 2]])
    expect(await Effect.runPromise(renderPrompt(workflow, issue, 4))).toBe('owner/repository#19 4')
  })

  it('fails strict prompt rendering for an unknown variable', async (): Promise<void> => {
    const path = await writeWorkflow(`---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TRACKER_TOKEN
---
{{ unknown.value }}
`)
    const workflow = await Effect.runPromise(loadWorkflow(path, { TRACKER_TOKEN: 'secret' }))
    const error = await Effect.runPromise(Effect.flip(renderPrompt(workflow, issue, null)))
    expect(error.category).toBe('template_render_error')
  })
})
