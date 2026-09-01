import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import {
  classifyPullRequest,
  type PullRequestObservation,
} from '@sloppenheimer/core/domain/handoff.js'
import {
  CurrentCodeReview,
  CurrentSourceControl,
  CurrentTracker,
  type CodeReviewPort,
} from '@sloppenheimer/core'
import { applicationPorts } from '../../src/composition.js'
import { withEnvironment } from '../harness/environment.js'
import { hostFileSystem } from '../harness/filesystem.js'

const observation: PullRequestObservation = {
  number: 19,
  state: 'open',
  url: 'https://github.com/Underzenith85/sloppenheimer-ts/pull/19',
  headSha: 'isolated-head',
  merged: false,
  mergeCommitSha: null,
  mergeable: true,
  mergeState: 'clean',
  checks: [{ name: 'check', status: 'completed', conclusion: 'success', url: null }],
  reviewDecision: 'APPROVED',
  reviewThreads: [],
}

const temporaryDirectories: string[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

/**
 * A workflow that names the extension explicitly. Every case below writes one rather than relying
 * on the default, so what the composition root answers is read off the document.
 */
const writeWorkflow = (handoffSection: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppenheimer-handoff-gate-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'WORKFLOW.md')
    await writeFile(
      path,
      `---
tracker:
  kind: github
  provider:
    owner: example
    repository: sloppenheimer
    token: $TEST_TRACKER_TOKEN
workspace:
  root: .workspaces
${handoffSection}---
Do the work
`,
    )
    return path
  })

type ComposedCapabilities = Readonly<{
  codeReviewComposed: boolean
  codeReviewCapability: Option.Option<CodeReviewPort>
  sourceControlComposed: boolean
  trackerComposed: boolean
}>

/** Builds the production layer for one workflow and reports which capabilities it composed. */
const composedCapabilities = (handoffSection: string): Effect.Effect<ComposedCapabilities> =>
  Effect.gen(function* () {
    const path = yield* writeWorkflow(handoffSection)
    return yield* Effect.gen(function* () {
      const codeReviewCell = yield* Effect.serviceOption(CurrentCodeReview)
      const sourceControlCell = yield* Effect.serviceOption(CurrentSourceControl)
      const trackerCell = yield* Effect.serviceOption(CurrentTracker)
      const capability = yield* Option.match(codeReviewCell, {
        onNone: () => Effect.succeed(Option.none<CodeReviewPort>()),
        onSome: (cell) => Effect.map(cell.get, Option.fromNullable),
      })
      return {
        codeReviewComposed: Option.isSome(codeReviewCell),
        codeReviewCapability: capability,
        sourceControlComposed: Option.isSome(sourceControlCell),
        trackerComposed: Option.isSome(trackerCell),
      }
    }).pipe(Effect.provide(applicationPorts(path)), Effect.provide(hostFileSystem), Effect.orDie)
  }).pipe((effect) => withEnvironment(effect, { TEST_TRACKER_TOKEN: 'secret' }))

describe('Extension Conformance: GitHub pull-request handoff', (): void => {
  it('requires checks, reviews, mergeability, and the observed head before merge', (): void => {
    expect(classifyPullRequest(observation)).toEqual({
      state: 'ready_to_merge',
      headSha: 'isolated-head',
    })
    expect(
      classifyPullRequest({
        ...observation,
        reviewThreads: [{ id: 'thread', resolved: false, body: 'change this', url: null }],
      }),
    ).toMatchObject({ state: 'repair_needed' })
  })

  it.effect('composes the code-review capability when handoff.enabled is set', () =>
    Effect.gen(function* () {
      const composed = yield* composedCapabilities('handoff:\n  enabled: true\n')

      expect(composed.codeReviewComposed).toBe(true)
      expect(Option.isSome(composed.codeReviewCapability)).toBe(true)
      expect(composed.sourceControlComposed).toBe(true)
    }),
  )

  it.effect('composes no code-review services when handoff.enabled is false', () =>
    Effect.gen(function* () {
      const composed = yield* composedCapabilities('handoff:\n  enabled: false\n')

      // Nothing to enable, disable or configure below this point: the orchestrator reads the
      // absence of the service, which is what leaves it on the core continuation lifecycle and
      // leaves `handoffs.json` unread.
      expect(composed.codeReviewComposed).toBe(false)
      // Preparing and publishing a branch is a capability of its own, so it survives the gate.
      expect(composed.sourceControlComposed).toBe(true)
      expect(composed.trackerComposed).toBe(true)
    }),
  )

  it.effect('enables the extension when the workflow declares no handoff section', () =>
    Effect.gen(function* () {
      const composed = yield* composedCapabilities('')

      expect(composed.codeReviewComposed).toBe(true)
      expect(Option.isSome(composed.codeReviewCapability)).toBe(true)
    }),
  )
})
