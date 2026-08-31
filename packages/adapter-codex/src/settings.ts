import { Effect } from 'effect'

import {
  agentRunnerSettingsOf,
  registerAgentRunner,
  type AgentRunnerAdapter,
  type RegisteredAgentRunner,
  type ValidatedAgentRunner,
} from '@symphony/core/domain/agent-runner-provider.js'
import type { JsonObject, JsonValue } from '@symphony/core/domain/domain.js'
import { WorkflowError } from '@symphony/core/domain/errors.js'
import { isJsonObject } from '@symphony/core/support/json.js'

/**
 * Codex's own settings, and the validation that owns them.
 *
 * The approval policy and the two sandbox fields used to be part of `AgentRunnerConfig` in the
 * core, and their permitted values were checked there. Both are Codex's business: they are aligned
 * with `codex app-server generate-json-schema`, and a second runner has neither concept. They now
 * live behind the opaque `runner.settings`, validated here and read back by the session that uses
 * them.
 */
export type CodexSettings = Readonly<{
  approvalPolicy: string
  threadSandbox: string
  /** Verbatim pass-through for the App Server turn sandbox policy. */
  turnSandboxPolicy: JsonObject | null
}>

/**
 * Codex-owned policy values. The App Server's `AskForApproval` also accepts a granular object form,
 * which this host does not expose.
 */
export const codexApprovalPolicies = ['untrusted', 'on-request', 'never'] as const
export const codexSandboxModes = ['read-only', 'workspace-write', 'danger-full-access'] as const

/**
 * Codex owns these authentication sources. The host never strips them from its subprocess
 * environments, and a workflow's tracker configuration may not reuse them.
 */
export const codexAuthenticationEnvironmentNames = ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'] as const

export const codexSettingsDefaults = Object.freeze({
  command: 'codex app-server',
  approvalPolicy: 'never',
  threadSandbox: 'workspace-write',
})

const invalid = (message: string): WorkflowError =>
  new WorkflowError({ category: 'invalid_config', message })

const enumerated = (
  settings: JsonObject,
  key: string,
  allowed: readonly string[],
  fallback: string,
): string => {
  const value: JsonValue | undefined = settings[key]
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(`runner.settings.${key} must be one of: ${allowed.join(', ')}`)
  }
  return value
}

const optionalObject = (settings: JsonObject, key: string): JsonObject | null => {
  const value: JsonValue | undefined = settings[key]
  if (value === undefined || value === null) {
    return null
  }
  if (!isJsonObject(value)) {
    throw invalid(`runner.settings.${key} must be a map`)
  }
  return value
}

/**
 * The Codex adapter owns this validation. `runner.settings` reaches it as the exact JSON object
 * that was authored, keyed as the document spells it, and an omitted field takes the documented
 * default rather than being rejected.
 */
export const validateCodexSettings = (
  settings: JsonObject,
): Effect.Effect<CodexSettings, WorkflowError> =>
  Effect.try({
    try: (): CodexSettings => ({
      approvalPolicy: enumerated(
        settings,
        'approval_policy',
        codexApprovalPolicies,
        codexSettingsDefaults.approvalPolicy,
      ),
      threadSandbox: enumerated(
        settings,
        'thread_sandbox',
        codexSandboxModes,
        codexSettingsDefaults.threadSandbox,
      ),
      turnSandboxPolicy: optionalObject(settings, 'turn_sandbox_policy'),
    }),
    catch: (cause: unknown): WorkflowError =>
      cause instanceof WorkflowError ? cause : invalid('runner.settings is not a valid selection'),
  })

const isCodexSettings = (value: unknown): value is CodexSettings => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  const policy = candidate['turnSandboxPolicy']
  return (
    typeof candidate['approvalPolicy'] === 'string' &&
    typeof candidate['threadSandbox'] === 'string' &&
    (policy === null || isJsonObject(policy))
  )
}

const sameCodexSettings = (left: CodexSettings, right: CodexSettings): boolean =>
  left.approvalPolicy === right.approvalPolicy &&
  left.threadSandbox === right.threadSandbox &&
  JSON.stringify(left.turnSandboxPolicy) === JSON.stringify(right.turnSandboxPolicy)

const codexRunnerAdapter: AgentRunnerAdapter<CodexSettings> = {
  kind: 'codex',
  defaultCommand: codexSettingsDefaults.command,
  authenticationEnvironmentNames: codexAuthenticationEnvironmentNames,
  validate: validateCodexSettings,
  isSettings: isCodexSettings,
  same: sameCodexSettings,
}

/** The registry entry: registering this is all it takes for a build to support `kind: codex`. */
export const codexAgentRunnerProvider: RegisteredAgentRunner =
  registerAgentRunner(codexRunnerAdapter)

/** Reads the Codex settings back out of a validated selection. */
export const codexSettingsOf = (selection: ValidatedAgentRunner): CodexSettings =>
  agentRunnerSettingsOf(codexRunnerAdapter, selection)

/**
 * Reads the Codex settings back out of the opaque value a launch carries. The launch holds the
 * validated settings rather than the whole selection, so this recognizes the settings directly.
 */
export const codexSettingsFrom = (settings: unknown): CodexSettings => {
  if (!isCodexSettings(settings)) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: 'agent runner settings are not codex settings',
    })
  }
  return settings
}
