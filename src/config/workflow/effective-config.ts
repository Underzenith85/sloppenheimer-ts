import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Effect, Either } from 'effect'

import { expandHomePath, resolvePathReference } from '@sloppenheimer/core/config/env-reference.js'
import {
  workflowDefaults,
  type EffectiveConfig,
  type RunnerConfig,
} from '@sloppenheimer/core/config/workflow.js'
import type { JsonObject } from '@sloppenheimer/core/domain/domain.js'
import { WorkflowError } from '@sloppenheimer/core/domain/errors.js'
import { emptyJsonObject, toJsonObject } from '@sloppenheimer/core/support/json.js'
import { jsonSafely, type RawWorkflowConfig } from './schema.js'

/**
 * Turning a decoded document into the configuration the core consumes: the one field that depends
 * on the environment, the runner the document selected, and the documented defaults for everything
 * it left out.
 */
/**
 * The fields the core consumes itself, spelled as the document spells them. They are the same under
 * `runner` and under the deprecated `codex` alias; everything else a runner section carries is that
 * adapter's business and travels through as `settings`.
 */
const neutralRunnerKeys = new Set([
  'command',
  'turn_timeout_ms',
  'read_timeout_ms',
  'stall_timeout_ms',
])

export const resolveWorkspaceRoot = (
  value: string | undefined,
  workflowPath: string,
): Effect.Effect<string, WorkflowError> =>
  (value === undefined
    ? Effect.succeed(join(tmpdir(), workflowDefaults.workspaceRootBasename))
    : resolvePathReference(value, 'workspace.root').pipe(Effect.map(expandHomePath))
  ).pipe(
    Effect.map((configured) =>
      resolve(isAbsolute(configured) ? configured : join(dirname(workflowPath), configured)),
    ),
  )

/**
 * Per-state limits are the one place a bad entry is dropped rather than rejected: the states a
 * tracker reports are the tracker's vocabulary, and a workflow naming one that cannot carry a limit
 * should not stop the run. A limit that is not a whole number above zero is no limit at all.
 */
const parseConcurrencyByState = (
  value: Readonly<Record<string, unknown>> | undefined,
): ReadonlyMap<string, number> =>
  new Map(
    Object.entries(value ?? {}).flatMap(([state, limit]) =>
      typeof limit === 'number' && Number.isInteger(limit) && limit > 0
        ? ([[state.trim().toLowerCase(), limit]] as const)
        : [],
    ),
  )

/**
 * The runner selection a document declares, before any adapter has seen it.
 *
 * Declaring both `runner` and the deprecated `codex` alias is refused rather than merged: the two
 * would have to be reconciled field by field, and an operator who wrote both has a belief about
 * which one is in force that this loader cannot read.
 */
type AuthoredRunner = Readonly<{
  kind: string | null
  settings: JsonObject
  /** The section name the author actually used, so a rejection can name it back to them. */
  section: 'runner' | 'codex'
}>

/**
 * Re-spells an adapter's rejection in the section the author wrote.
 *
 * An adapter validates `runner.settings` and says so, because that is the only name it knows. A
 * document using the deprecated alias never wrote those words, and this file's whole convention is
 * that a message names what the author wrote rather than a position in a decoded tree. The alias is
 * this loader's fiction, so translating the message back out of it is this loader's job.
 */
export const inAuthoredSection = (
  section: AuthoredRunner['section'],
  error: WorkflowError,
): WorkflowError =>
  section === 'runner'
    ? error
    : new WorkflowError({
        category: error.category,
        message: error.message.replace(/^runner\.settings\./u, 'codex.'),
        cause: error.cause,
      })

export const authoredRunner = (
  raw: RawWorkflowConfig,
  frontMatter: JsonObject,
): Effect.Effect<AuthoredRunner, WorkflowError> => {
  if (raw.runner !== undefined && raw.codex !== undefined) {
    return Effect.fail(
      new WorkflowError({
        category: 'invalid_config',
        message:
          'runner and codex must not both be declared; codex is the deprecated spelling of runner.kind codex',
      }),
    )
  }
  if (raw.runner !== undefined) {
    return Effect.succeed({
      kind: raw.runner.kind ?? null,
      settings: raw.runner.settings ?? emptyJsonObject,
      section: 'runner',
    })
  }
  if (raw.codex === undefined) {
    return Effect.succeed({ kind: null, settings: emptyJsonObject, section: 'runner' })
  }
  // Under the alias the adapter's settings are whatever the block carries beyond the neutral
  // fields, read from the authored map so a key this loader no longer knows still reaches the
  // adapter that does. It is converted rather than tested: a value JSON cannot carry has to be
  // reported against the key that holds it, not quietly dropped on the way to the adapter.
  return Either.match(
    jsonSafely(() => toJsonObject(frontMatter['codex'], 'codex'), 'codex'),
    {
      onLeft: (message) => Effect.fail(new WorkflowError({ category: 'invalid_config', message })),
      onRight: (authored) =>
        Effect.succeed({
          kind: 'codex',
          settings: Object.freeze(
            Object.fromEntries(
              Object.entries(authored).filter(([key]) => !neutralRunnerKeys.has(key)),
            ),
          ),
          section: 'codex' as const,
        }),
    },
  )
}

/**
 * The rest of the configuration, once the one environment-dependent field is resolved. Every value
 * here has already been checked by the schema, so this only applies the documented defaults.
 *
 * `defaultCommand` comes from the selected runner's adapter rather than from `workflowDefaults`: it
 * names a specific executable, which is the one part of the neutral configuration only the backend
 * can supply.
 */
export const parseConfig = (
  raw: RawWorkflowConfig,
  workspaceRoot: string,
  runner: AuthoredRunner,
  defaultCommand: string,
): EffectiveConfig => {
  const { tracker, polling, hooks, agent, codex, server, handoff } = raw
  const declared = raw.runner ?? codex
  const runnerConfig: RunnerConfig = {
    command: declared?.command ?? defaultCommand,
    turnTimeoutMs: declared?.turn_timeout_ms ?? workflowDefaults.turnTimeoutMs,
    readTimeoutMs: declared?.read_timeout_ms ?? workflowDefaults.readTimeoutMs,
    stallTimeoutMs: declared?.stall_timeout_ms ?? workflowDefaults.stallTimeoutMs,
    settings: runner.settings,
  }
  return {
    tracker: {
      kind: tracker.kind,
      provider: tracker.provider,
      requiredLabels: (tracker.required_labels ?? []).map((label) => label.trim().toLowerCase()),
      activeStates: tracker.active_states ?? workflowDefaults.activeStates,
      terminalStates: tracker.terminal_states ?? workflowDefaults.terminalStates,
    },
    pollingIntervalMs: polling?.interval_ms ?? workflowDefaults.pollingIntervalMs,
    workspaceRoot,
    hooks: {
      afterCreate: hooks?.after_create ?? null,
      beforeRun: hooks?.before_run ?? null,
      afterRun: hooks?.after_run ?? null,
      beforeRemove: hooks?.before_remove ?? null,
      timeoutMs: hooks?.timeout_ms ?? workflowDefaults.hookTimeoutMs,
    },
    agent: {
      maxConcurrentAgents: agent?.max_concurrent_agents ?? workflowDefaults.maxConcurrentAgents,
      maxTurns: agent?.max_turns ?? workflowDefaults.maxTurns,
      maxRetryBackoffMs: agent?.max_retry_backoff_ms ?? workflowDefaults.maxRetryBackoffMs,
      maxConcurrentAgentsByState: parseConcurrencyByState(agent?.max_concurrent_agents_by_state),
    },
    runner: runnerConfig,
    serverPort: server?.port ?? null,
    handoffEnabled: handoff?.enabled ?? workflowDefaults.handoffEnabled,
    extensions: raw.extensions,
  }
}
