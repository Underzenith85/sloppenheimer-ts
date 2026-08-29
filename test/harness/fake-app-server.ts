import { fileURLToPath } from 'node:url'

export type FakeAppServerScenario =
  | 'complete'
  | 'approval'
  | 'diagnostic'
  | 'unsupported-tool'
  | 'user-input'
  | 'read-timeout'
  | 'turn-timeout'

const fixturePath = fileURLToPath(new URL('../fixtures/fake-app-server.ts', import.meta.url))

/** Shell command accepted by the real Codex subprocess boundary. */
export const fakeAppServerCommand = (scenario: FakeAppServerScenario): string =>
  `${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(fixturePath)} ${JSON.stringify(scenario)}`
