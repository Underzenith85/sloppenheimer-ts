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
}

/** Shell command accepted by the real Codex subprocess boundary. */
export type FakeAppServerExpectation = Readonly<{
  approvalPolicy: string
  threadSandbox: string
  turnSandboxPolicy: Readonly<Record<string, unknown>> | null
}>

export const fakeAppServerCommand = (
  scenario: FakeAppServerScenario,
  expectation?: FakeAppServerExpectation,
): string => {
  const argument =
    expectation === undefined ? '' : ` ${JSON.stringify(JSON.stringify(expectation))}`
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} ${JSON.stringify(fixtureScenario[scenario])}${argument}`
}
