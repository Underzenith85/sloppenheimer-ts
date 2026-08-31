import type { CodexSettings } from '@symphony/adapter-codex'
import type { AgentRunnerConfig } from '@symphony/core/ports/agent-runner.js'

/**
 * A Codex launch configuration, in the shape the neutral port now carries.
 *
 * The approval policy and the two sandbox fields used to sit beside `command` on the port; they are
 * Codex's own settings and travel opaquely now, so every fixture builds them here rather than
 * restating the split at each call site.
 */
export const codexFixtureSettings: CodexSettings = Object.freeze({
  approvalPolicy: 'never',
  threadSandbox: 'workspace-write',
  turnSandboxPolicy: null,
})

export const codexRunnerConfig = (
  overrides: Partial<AgentRunnerConfig> = {},
): AgentRunnerConfig => ({
  command: 'codex app-server',
  turnTimeoutMs: 3_600_000,
  readTimeoutMs: 5_000,
  stallTimeoutMs: 300_000,
  settings: codexFixtureSettings,
  ...overrides,
})

/** The same, with settings overridden rather than replaced. */
export const codexRunnerConfigWith = (
  settings: Partial<CodexSettings>,
  overrides: Partial<AgentRunnerConfig> = {},
): AgentRunnerConfig =>
  codexRunnerConfig({ ...overrides, settings: { ...codexFixtureSettings, ...settings } })
