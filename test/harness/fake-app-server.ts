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

const fixtureScenario: Readonly<Record<FakeAppServerScenario, string>> = {
  complete: 'usage',
  approval: 'approval',
  diagnostic: 'stderr-noise',
  'unsupported-tool': 'unsupported-request',
  'user-input': 'input-required',
  'read-timeout': 'startup-silent',
  'turn-timeout': 'silent-turn',
}

/** Shell command accepted by the real Codex subprocess boundary. */
export const fakeAppServerCommand = (scenario: FakeAppServerScenario): string =>
  `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} ${JSON.stringify(fixtureScenario[scenario])}`
