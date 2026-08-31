import { Effect } from 'effect'

import {
  agentRunnerSettingsOf,
  makeAgentRunnerRegistry,
  registerAgentRunner,
  type AgentRunnerAdapter,
  type AgentRunnerRegistry,
  type ValidatedAgentRunner,
} from '@symphony/core/domain/agent-runner-provider.js'
import { WorkflowError } from '@symphony/core/domain/errors.js'
import type { AgentEvent, AgentLifecycle, AgentTurnOutcome } from '@symphony/core/telemetry.js'
import { withEnvironment } from './environment.js'

/**
 * A deliberately alien agent runner.
 *
 * Every string it chooses is picked to share no substring with Codex's: its kind, its event names,
 * its settings keys, and its authentication variables. That is the whole point of it. A suite that
 * only proves "Codex still works" passes against an abstraction that is still leaky, because Codex
 * is what the leaks were shaped around; driving the same orchestrator through a runner that agrees
 * with Codex about nothing is what actually proves the core stopped reading one backend's
 * vocabulary.
 *
 * If any literal Codex name returns to `packages/core`, the lifecycle assertions here stop holding.
 */
export type AuroraSettings = Readonly<{ tempo: string }>

export const auroraTempos = ['largo', 'presto'] as const

/** Nothing Codex authenticates with, so a collision here is a different rule being tested. */
export const auroraAuthenticationEnvironmentNames = ['AURORA_SIGNING_KEY'] as const

/**
 * Aurora's event vocabulary. No member of it contains `session`, `turn`, `started`, `completed`,
 * `failed` or `terminated`, so the orchestrator cannot recognize any of them by accident.
 */
export const auroraEvents = Object.freeze({
  bootstrap: 'aurora.bootstrap',
  legOpened: 'aurora.leg.opened',
  legSealed: 'aurora.leg.sealed',
  chatter: 'aurora.chatter',
})

const isAuroraSettings = (value: unknown): value is AuroraSettings =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>)['tempo'] === 'string'

export const auroraRunnerAdapter: AgentRunnerAdapter<AuroraSettings> = {
  kind: 'aurora',
  defaultCommand: 'aurora --serve',
  authenticationEnvironmentNames: auroraAuthenticationEnvironmentNames,
  validate: (settings) => {
    const tempo = settings['tempo'] ?? 'largo'
    if (
      typeof tempo !== 'string' ||
      !auroraTempos.includes(tempo as (typeof auroraTempos)[number])
    ) {
      return Effect.fail(
        new WorkflowError({
          category: 'invalid_config',
          message: `runner.settings.tempo must be one of: ${auroraTempos.join(', ')}`,
        }),
      )
    }
    return Effect.succeed({ tempo })
  },
  isSettings: isAuroraSettings,
  same: (left, right) => left.tempo === right.tempo,
}

export const auroraRunnerEntry = registerAgentRunner(auroraRunnerAdapter)

export const auroraRunners: AgentRunnerRegistry = makeAgentRunnerRegistry([auroraRunnerEntry])

/**
 * A validated Aurora selection. Run here rather than yielded: every caller is a module-scope
 * fixture constant, and validation against a fixed literal reads no environment and cannot fail.
 */
export const auroraRunner = (tempo: string = 'largo'): ValidatedAgentRunner =>
  Effect.runSync(withEnvironment(auroraRunners.validate('aurora', { tempo })))

export const auroraTempo = (selection: ValidatedAgentRunner): string =>
  agentRunnerSettingsOf(auroraRunnerAdapter, selection).tempo

/** The lifecycle Aurora states for each of its own events, which is the only reading of them. */
export const auroraLifecycle = (
  event: string,
  outcome: AgentTurnOutcome = 'completed',
): AgentLifecycle | null => {
  switch (event) {
    case auroraEvents.bootstrap: {
      return { phase: 'session_started' }
    }
    case auroraEvents.legOpened: {
      return { phase: 'turn_started' }
    }
    case auroraEvents.legSealed: {
      return { phase: 'turn_settled', outcome }
    }
    default: {
      return null
    }
  }
}

/** One Aurora event, shaped the way its adapter would hand it to the runtime. */
export const auroraEvent = (
  event: string,
  overrides: Partial<AgentEvent> = {},
  outcome: AgentTurnOutcome = 'completed',
): AgentEvent => ({
  event,
  timestamp: new Date('2026-01-01T00:00:00.000Z'),
  processId: 4242,
  message: null,
  usage: null,
  rateLimits: null,
  threadId: 'aurora-thread',
  turnId: event === auroraEvents.bootstrap ? null : 'aurora-leg-1',
  sessionId: 'aurora-thread-aurora-leg-1',
  turnCount: event === auroraEvents.bootstrap ? 0 : 1,
  // Aurora reports no status string at all. Anything that still needed one to recognize a settled
  // turn would fail here rather than degrade quietly.
  turnStatus: null,
  payload: { kind: 'none' },
  lifecycle: auroraLifecycle(event, outcome),
  ...overrides,
})

/**
 * A validated selection of an arbitrary kind, for the one rule that is about the kind alone: a
 * reload may change everything about how a runner is configured, but not which runner it is.
 */
export const stubRunner = (kind: string): ValidatedAgentRunner =>
  Object.freeze({
    kind,
    settings: { tempo: 'largo' },
    authenticationEnvironmentNames: [],
    sameAs: (other: ValidatedAgentRunner): boolean => other.kind === kind,
    revalidate: (): Effect.Effect<ValidatedAgentRunner, WorkflowError> =>
      Effect.succeed(stubRunner(kind)),
  })
