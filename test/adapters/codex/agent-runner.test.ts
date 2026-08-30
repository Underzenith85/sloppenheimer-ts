import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  codexAgentEventSemantics,
  codexAgentRunner,
  layerCodexAgentRunner,
} from '../../../src/adapters/codex/agent-runner.js'
import { runAgent } from '../../../src/adapters/codex/codex.js'
import { AgentRunner } from '../../../src/ports/agent-runner.js'

describe('Codex agent runner adapter', (): void => {
  it('satisfies the port with the App Server session', (): void => {
    expect(codexAgentRunner.run).toBe(runAgent)
  })

  it('provides the agent runner tag from its layer', async (): Promise<void> => {
    const provided = await Effect.runPromise(
      AgentRunner.pipe(Effect.provide(layerCodexAgentRunner)),
    )

    expect(provided).toBe(codexAgentRunner)
  })

  it('reads Codex turn statuses as port outcomes', (): void => {
    const { turnOutcome } = codexAgentEventSemantics

    expect(turnOutcome('completed')).toBe('completed')
    expect(turnOutcome('cancelled')).toBe('cancelled')
    expect(turnOutcome('canceled')).toBe('cancelled')
    expect(turnOutcome('interrupted')).toBe('cancelled')
    expect(turnOutcome('failed')).toBe('failed')
    expect(turnOutcome('anything else')).toBe('failed')
  })
})
