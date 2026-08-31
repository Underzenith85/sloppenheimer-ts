import { fileURLToPath } from 'node:url'

export type FakeAppServerScenario =
  | 'complete'
  | 'approval'
  | 'file-approval'
  | 'configured-policies'
  | 'diagnostic'
  | 'unsupported-tool'
  | 'user-input'
  | 'read-timeout'
  | 'turn-timeout'
  | 'stubborn-grandchild'

const fixturePath = fileURLToPath(new URL('../fixtures/fake-app-server.ts', import.meta.url))

const fixtureScenario: Readonly<Record<FakeAppServerScenario, string>> = {
  complete: 'usage',
  approval: 'approval',
  'file-approval': 'file-approval',
  'configured-policies': 'usage',
  diagnostic: 'stderr-noise',
  'unsupported-tool': 'unsupported-request',
  'user-input': 'input-required',
  'read-timeout': 'startup-silent',
  'turn-timeout': 'silent-turn',
  // Starts a turn and never finishes it, leaving behind a descendant that ignores SIGTERM. It is
  // what a host cleaning up live workers has to contend with.
  'stubborn-grandchild': 'stubborn-grandchild',
}

/** Shell command accepted by the real Codex subprocess boundary. */
export type FakeAppServerExpectation = Readonly<{
  approvalPolicy: string
  threadSandbox: string
  turnSandboxPolicy: Readonly<Record<string, unknown>> | null
  /**
   * Accept whatever host tools the caller advertises. Set it when the test is about the host's
   * lifecycle rather than the exact tool payload, so the fixture does not have to restate the
   * composition root's tool set.
   */
  acceptAnyDynamicTools?: boolean
}>

export const fakeAppServerCommand = (
  scenario: FakeAppServerScenario,
  expectation?: FakeAppServerExpectation,
): string => {
  const argument =
    expectation === undefined ? '' : ` ${JSON.stringify(JSON.stringify(expectation))}`
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} ${JSON.stringify(fixtureScenario[scenario])}${argument}`
}
