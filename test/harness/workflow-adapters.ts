import { codexAgentRunnerProvider } from '@sloppenheimer/adapter-codex'
import {
  makeAgentRunnerRegistry,
  type AgentRunnerRegistry,
} from '@sloppenheimer/core/domain/agent-runner-provider.js'
import type { TrackerProviderRegistry } from '@sloppenheimer/core/domain/tracker-provider.js'
import type { WorkflowAdapters } from '../../src/config/workflow.js'
import { auroraRunnerEntry } from './alien-agent-runner.js'

/**
 * The runner kinds a workflow suite loads against: the real Codex entry, so the deprecated `codex`
 * alias is exercised against the adapter that actually owns it, and the alien Aurora entry beside
 * it, so a document can select a second kind and prove the selection is read rather than assumed.
 */
export const testAgentRunners: AgentRunnerRegistry = makeAgentRunnerRegistry([
  codexAgentRunnerProvider,
  auroraRunnerEntry,
])

/** The adapter bundle `loadWorkflow` takes, for a suite that only varies the tracker registry. */
export const workflowAdaptersFor = (trackers: TrackerProviderRegistry): WorkflowAdapters => ({
  trackers,
  runners: testAgentRunners,
  defaultRunnerKind: codexAgentRunnerProvider.kind,
})
