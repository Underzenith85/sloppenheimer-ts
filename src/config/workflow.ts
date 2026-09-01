import { FileSystem } from '@effect/platform'
import { createHash } from 'node:crypto'
import { Effect, Option } from 'effect'

import type { Workflow } from '@sloppenheimer/core/config/workflow.js'
import { WorkflowError } from '@sloppenheimer/core/domain/errors.js'
import type {
  AgentRunnerRegistry,
  ValidatedAgentRunner,
} from '@sloppenheimer/core/domain/agent-runner-provider.js'
import type { PreflightResult } from '@sloppenheimer/core/ports/workflow.js'
import type {
  TrackerProviderRegistry,
  ValidatedTrackerProvider,
} from '@sloppenheimer/core/domain/tracker-provider.js'
import { isJsonObject } from '@sloppenheimer/core/support/json.js'
import { readWorkflowSource, frontMatterMap, splitWorkflow } from './workflow/document.js'
import {
  authoredRunner,
  inAuthoredSection,
  parseConfig,
  resolveWorkspaceRoot,
} from './workflow/effective-config.js'
import { decodeFrontMatter } from './workflow/schema.js'

/**
 * Reading a workflow definition off disk is composition-root work: the shapes it produces
 * ({@link Workflow}, {@link EffectiveConfig}) are core vocabulary, but the YAML dialect, the
 * environment indirection, and the filesystem are the application's business. The composition root
 * binds this module to `WorkflowLoader` so that no layer below it names a file format.
 *
 * This module is the load itself and the preflight that repeats its validation. The parts it is
 * assembled from are:
 *
 * - `workflow/document.ts` — the file, its front matter, and the prompt template after it.
 * - `workflow/schema.ts` — the authored vocabulary, as a schema that decodes it.
 * - `workflow/effective-config.ts` — the decoded document as the configuration the core consumes.
 */

/**
 * Re-runs the validation that must hold before every dispatch: an adapter-accepted
 * `tracker.provider` (including its secret indirection) and a usable `codex.command`.
 *
 * The provider is re-read from the workflow, so an edit to `tracker.provider` takes effect; the
 * adapter that validates it comes from the selection rather than from a registry looked up again by
 * kind. A workflow loaded with a caller's own registry therefore keeps revalidating through that
 * registry's adapter: routing this through a default registry instead would report every kind the
 * default does not carry as unsupported, and the run would silently keep its superseded credential.
 */
export const preflightWorkflow = (
  workflow: Workflow,
): Effect.Effect<PreflightResult, WorkflowError> =>
  Effect.suspend(() =>
    workflow.config.runner.command.trim().length === 0
      ? Effect.fail(
          new WorkflowError({
            category: 'invalid_config',
            message: 'runner.command must be a non-empty string',
          }),
        )
      : // Both selections are revalidated, each through the adapter that produced it, and both are
        // returned. An adapter resolves `$VAR` indirection at validation time, so discarding either
        // would revalidate a rotated credential and then go on using the superseded one. The rule
        // between them is re-checked against the results, so a rotated tracker token that collides
        // with the runner's own authentication fails preflight rather than dispatch.
        Effect.all({
          runner: workflow.runner.revalidate(workflow.config.runner.settings),
          tracker: workflow.tracker.revalidate(workflow.config.tracker.provider),
        }).pipe(Effect.tap(({ tracker, runner }) => reserveRunnerCredentials(tracker, runner))),
  ).pipe(
    Effect.catchAllDefect((cause: unknown) =>
      Effect.fail(
        new WorkflowError({
          category: 'invalid_config',
          message: 'workflow preflight validation failed',
          cause,
        }),
      ),
    ),
  )

/**
 * The adapters a workflow is read against: which tracker kinds this build supports, which runner
 * kinds it supports, and which runner a document that names none is read as.
 *
 * The default kind is supplied rather than assumed because this module must not name a backend;
 * the composition root's runner registry is the one place a concrete kind appears.
 */
export type WorkflowAdapters = Readonly<{
  trackers: TrackerProviderRegistry
  runners: AgentRunnerRegistry
  defaultRunnerKind: string
}>

/**
 * The registered runner for a kind, so the default command is known before the configuration is
 * assembled. `validate` reports the unsupported kind too, but only after the command default has
 * already been needed.
 */
const unsupportedRunnerKind = (
  runners: AgentRunnerRegistry,
  kind: string,
): Effect.Effect<Readonly<{ defaultCommand: string }>, WorkflowError> =>
  Option.match(runners.get(kind), {
    onNone: () =>
      Effect.fail(
        new WorkflowError({
          category: 'invalid_config',
          message: `unsupported runner.kind: ${kind} (supported: ${runners.kinds.join(', ')})`,
        }),
      ),
    onSome: (entry) => Effect.succeed(entry),
  })

/**
 * Refuses a tracker credential that names one of the selected runner's own authentication
 * variables.
 *
 * The host has to both strip tracker secrets from the agent's environment and preserve the
 * runner's authentication in it; a variable that is both cannot be honoured either way. The rule
 * used to be a constant inside the secret resolver, which meant it only ever knew one backend's
 * names. It belongs here instead: this is the one place both selections are in hand, and the names
 * come from whichever runner the workflow actually chose.
 */
const reserveRunnerCredentials = (
  tracker: ValidatedTrackerProvider,
  runner: ValidatedAgentRunner,
): Effect.Effect<void, WorkflowError> => {
  const reserved = new Set(runner.authenticationEnvironmentNames)
  const collision = tracker.secretEnvironmentNames.find((name) => reserved.has(name))
  return collision === undefined
    ? Effect.void
    : Effect.fail(
        new WorkflowError({
          category: 'invalid_config',
          message: `tracker credentials must not use ${runner.kind} authentication environment variable ${collision}`,
        }),
      )
}

/**
 * Reads and validates a workflow definition.
 *
 * `providers` is supplied by the caller rather than defaulted here: the registry names concrete
 * adapters, and this layer must not reach up to the composition root to find them. The selection
 * this returns carries the adapter that validated it, so every later revalidation stays with the
 * registry used here.
 *
 * The environment is read through the calling fiber's `ConfigProvider` rather than passed in, so a
 * caller supplies a test provider the same way production supplies the process environment.
 */
export const loadWorkflow = (
  path: string,
  adapters: WorkflowAdapters,
): Effect.Effect<Workflow, WorkflowError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const source = yield* readWorkflowSource(path)
    const definition = yield* splitWorkflow(source)
    const frontMatter = yield* frontMatterMap(definition.config)
    const raw = yield* decodeFrontMatter(frontMatter)
    const workspaceRoot = yield* resolveWorkspaceRoot(raw.workspace?.root, path)
    const authored = yield* authoredRunner(raw, isJsonObject(frontMatter) ? frontMatter : {})
    const kind = authored.kind ?? adapters.defaultRunnerKind
    // The runner is selected before the configuration is assembled, because the default command is
    // the adapter's rather than this loader's, and validated before the tracker, because the
    // credential rule below is stated against the runner's own authentication.
    const entry = yield* unsupportedRunnerKind(adapters.runners, kind)
    const config = parseConfig(raw, workspaceRoot, authored, entry.defaultCommand)
    const runner = yield* adapters.runners
      .validate(kind, authored.settings)
      .pipe(Effect.mapError((error) => inAuthoredSection(authored.section, error)))
    const tracker = yield* adapters.trackers.validate(config.tracker.kind, config.tracker.provider)
    yield* reserveRunnerCredentials(tracker, runner)
    return {
      path,
      fingerprint: createHash('sha256').update(source).digest('hex'),
      config,
      tracker,
      runner,
      promptTemplate: definition.prompt,
    }
  })
