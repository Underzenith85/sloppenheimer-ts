import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect } from 'effect'

import { trackerProviders } from '../../src/tracker-adapters.js'
import { withEnvironment } from '../harness/environment.js'
import { afterEach, describe, expect } from 'vitest'

import { issueId, issueIdentifier, type Issue } from '@symphony/core/domain/domain.js'
import { renderPrompt, type Workflow } from '@symphony/core/config/workflow.js'
import { loadWorkflow } from '../../src/config/workflow.js'
import type { WorkflowError } from '@symphony/core/domain/errors.js'
import { hostFileSystem } from '../harness/filesystem.js'
import { workflowAdaptersFor } from '../harness/workflow-adapters.js'

/** The workflow source is read through `FileSystem`; these tests read the files they wrote. */
const loadHostWorkflow = (path: string): Effect.Effect<Workflow, WorkflowError> =>
  loadWorkflow(path, workflowAdaptersFor(trackerProviders)).pipe(Effect.provide(hostFileSystem))

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
  it.effect.each([
    ['invalid YAML', '---\ntracker: [unterminated\n---\nprompt', 'workflow_parse_error'],
    [
      'non-map front matter',
      '---\n- not\n- a\n- map\n---\nprompt',
      'workflow_front_matter_not_a_map',
    ],
  ] as const)('returns a typed error for %s', ([, source, category]) =>
    Effect.gen(function* () {
      const path = yield* Effect.promise(() => writeWorkflow(source))
      const error = yield* Effect.flip(withEnvironment(loadHostWorkflow(path)))
      expect(error.category).toBe(category)
    }),
  )

  it.effect('preserves shell commands and normalizes only valid per-state limits', () =>
    Effect.gen(function* () {
      const path = yield* Effect.promise(() =>
        writeWorkflow(`---
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
`),
      )
      const workflow = yield* withEnvironment(loadHostWorkflow(path), { TRACKER_TOKEN: 'secret' })
      expect(workflow.config.runner.command).toBe('printf "$UNCHANGED" | codex app-server')
      expect([...workflow.config.agent.maxConcurrentAgentsByState]).toEqual([['ready', 2]])
      expect(yield* renderPrompt(workflow, issue, 4)).toBe('owner/repository#19 4')
    }),
  )

  it.effect('fails strict prompt rendering for an unknown variable', () =>
    Effect.gen(function* () {
      const path = yield* Effect.promise(() =>
        writeWorkflow(`---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TRACKER_TOKEN
---
{{ unknown.value }}
`),
      )
      const workflow = yield* withEnvironment(loadHostWorkflow(path), { TRACKER_TOKEN: 'secret' })
      const error = yield* Effect.flip(renderPrompt(workflow, issue, null))
      expect(error.category).toBe('template_render_error')
    }),
  )
})
