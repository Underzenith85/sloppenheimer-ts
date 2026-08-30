import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

/**
 * Fixture modules laid out like `src/`, each one either a deliberate violation of the import
 * direction or the permitted case that must stay quiet.  Linting them with the repository's own
 * `.oxlintrc.json` is what proves the rule fires; asserting on the rule text alone would not.
 */
const fixtures: Readonly<Record<string, string>> = {
  // support/ is the bottom layer and may reach nothing above it.
  'src/support/violates-domain.ts': "import '../domain/domain.js'\n",
  'src/support/violates-root.ts': "import '../errors.js'\n",
  'src/support/permitted.ts': "import 'node:path'\nimport './json.js'\n",

  // domain/ may use support/ and nothing else.
  'src/domain/violates-core.ts': "import '../core/runtime.js'\n",
  'src/domain/violates-adapters.ts': "import '../adapters/github/tracker.js'\n",
  'src/domain/violates-config.ts': "import '../config/workflow.js'\n",
  'src/domain/violates-operator.ts': "import '../operator/operator.js'\n",
  'src/domain/permitted.ts': "import '../support/json.js'\n",

  // ports/ may use domain/ and support/ and nothing else.
  'src/ports/violates-config.ts': "import '../config/workflow.js'\n",
  'src/ports/violates-root.ts': "import '../tracker.js'\n",
  'src/ports/permitted.ts': "import '../domain/domain.js'\nimport '../support/json.js'\n",

  // core/ holds policy and may not name a concrete adapter.  This is the drift the rule exists to
  // stop: `src/orchestrator.ts` importing `makeGitHubTracker` by name.
  'src/core/violates-adapters.ts':
    "import { makeGitHubTracker } from '../adapters/github/tracker.js'\nexport const bound = makeGitHubTracker\n",
  'src/core/violates-adapters-reexport.ts': "export * from '../adapters/github/tracker.js'\n",
  'src/core/violates-adapters-dynamic.ts':
    "export const load = async (): Promise<unknown> => import('../adapters/codex/agent.js')\n",
  'src/core/violates-operator.ts': "import '../operator/operator.js'\n",
  'src/core/permitted.ts':
    "import '../config/workflow.js'\nimport '../domain/domain.js'\nimport '../ports/tracker.js'\nimport '../support/json.js'\nimport '../errors.js'\n",
  // The migration allow-list keeps the modules #84 left at the `src/` root reachable from core/.
  'src/core/permitted-allow-list.ts':
    "import '../codex.js'\nimport '../handoff-store.js'\nimport '../host-tools.js'\nimport '../telemetry.js'\nimport '../tracker.js'\nimport '../workspace.js'\n",

  // adapters/ is restricted as an import target, never as a source, and the `src/` root is the
  // composition root that deliberately binds concrete adapters.
  'src/adapters/github/permitted.ts':
    "import '../../core/runtime.js'\nimport '../../ports/tracker.js'\n",
  'src/composition-root.ts': "import './adapters/github/tracker.js'\nimport './core/runtime.js'\n",
}

const expectedViolations: readonly string[] = Object.keys(fixtures)
  .filter((path) => path.includes('violates'))
  .sort()

let reported: readonly string[] = []

let fixtureRoot = ''

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'symphony-import-boundaries-'))

  for (const [path, contents] of Object.entries(fixtures)) {
    const target = join(fixtureRoot, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents, 'utf8')
  }

  // Lint the fixture tree with the repository's own configuration rather than a copy written for
  // the test, so the assertions below fail if the shipped rule is weakened or deleted.
  copyFileSync(join(repoRoot, '.oxlintrc.json'), join(fixtureRoot, '.oxlintrc.json'))
  symlinkSync(join(repoRoot, 'node_modules'), join(fixtureRoot, 'node_modules'), 'dir')
  writeFileSync(
    join(fixtureRoot, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  const lint = spawnSync(join(repoRoot, 'node_modules', '.bin', 'oxlint'), ['--deny-warnings'], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  })

  expect(lint.error).toBeUndefined()

  const output = `${lint.stdout}${lint.stderr}`
  reported = [
    ...new Set(
      [...output.matchAll(/^(\S+?):\d+:\d+: error eslint\(no-restricted-imports\)/gm)].map(
        (match) => match[1] ?? '',
      ),
    ),
  ].sort()

  expect(lint.status, `oxlint reported no violations:\n${output}`).not.toBe(0)
})

afterAll(() => {
  if (fixtureRoot !== '') {
    rmSync(fixtureRoot, { force: true, recursive: true })
  }
})

describe('module import direction', () => {
  it('rejects every deliberate violation of the layering', () => {
    expect(reported).toStrictEqual(expectedViolations)
  })

  it.each(expectedViolations)('rejects %s', (path) => {
    expect(reported).toContain(path)
  })

  it.each(
    Object.keys(fixtures)
      .filter((path) => !path.includes('violates'))
      .sort(),
  )('permits %s', (path) => {
    expect(reported).not.toContain(path)
  })
})
