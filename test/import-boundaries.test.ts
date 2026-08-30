import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

/**
 * Fixture modules laid out like `src/`, each one either a deliberate violation of the import
 * direction or the permitted case that must stay quiet.  Linting them with the repository's own
 * `.oxlintrc.json` is what proves the rule fires; asserting on the rule text alone would not.
 *
 * The targets need not exist: `no-restricted-imports` matches the specifier as written.
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
  'src/ports/violates-config.ts': "import '../config/cli-options.js'\n",
  'src/ports/violates-root.ts': "import '../tracker.js'\n",
  'src/ports/permitted.ts': "import '../domain/domain.js'\nimport '../support/json.js'\n",
  // The migration allow-list keeps the vocabulary #88 declared the ports against reachable, but
  // only as types: a port must not acquire a runtime dependency on configuration or on root
  // infrastructure under cover of the exemption.
  'src/ports/permitted-allow-list.ts':
    "import type { ValidatedTrackerProvider } from '../config/tracker-config.js'\nimport type { Workflow } from '../config/workflow.js'\nimport type { TrackerError } from '../errors.js'\nimport type { HostToolSpec } from '../host-tools.js'\nimport type { AgentEvent } from '../telemetry.js'\n\nexport type Vocabulary = [ValidatedTrackerProvider, Workflow, TrackerError, HostToolSpec, AgentEvent]\n",
  'src/ports/violates-allow-list-value.ts':
    "import { loadWorkflow } from '../config/workflow.js'\n\nexport const load = loadWorkflow\n",
  'src/ports/violates-allow-list-side-effect.ts': "import '../telemetry.js'\n",

  // core/ holds policy and may not name a concrete adapter.  This is the drift the rule exists to
  // stop: the composition root importing `makeGitHubTracker` by name from inside core.
  'src/core/violates-adapters.ts':
    "import { makeGitHubTracker } from '../adapters/github/tracker.js'\n\nexport const bound = makeGitHubTracker\n",
  'src/core/violates-adapters-reexport.ts': "export * from '../adapters/github/tracker.js'\n",
  'src/core/violates-adapters-dynamic.ts':
    "export const load = async (): Promise<unknown> => import('../adapters/codex/agent.js')\n",
  'src/core/violates-operator.ts': "import '../operator/operator.js'\n",
  'src/core/permitted.ts':
    "import '../config/workflow.js'\nimport '../domain/domain.js'\nimport '../errors.js'\nimport '../ports/tracker.js'\nimport '../support/json.js'\n",
  // The migration allow-list keeps the modules #84 left at the `src/` root reachable from core/.
  'src/core/permitted-allow-list.ts':
    "import '../codex.js'\nimport '../handoff-store.js'\nimport '../host-tools.js'\nimport '../telemetry.js'\nimport '../tracker.js'\nimport '../workspace.js'\n",

  // adapters/ is restricted as an import target, never as a source, and the `src/` root is the
  // composition root that deliberately binds concrete adapters.
  'src/adapters/github/permitted.ts':
    "import '../../core/runtime.js'\nimport '../../ports/tracker.js'\n",
  'src/composition-root.ts': "import './adapters/github/tracker.js'\nimport './core/runtime.js'\n",

  /*
   * Nested modules.  The layers are flat today, but a rule that rejects a compliant directory
   * refactor would block the restructuring issues under #76 rather than guard them, so a nested
   * module must still be denied the layers above it and must keep its same-layer and lower-layer
   * imports.  These specifiers carry an extra `../` that the depth-one patterns do not match.
   */
  'src/support/nested/violates-domain.ts': "import '../../domain/domain.js'\n",
  'src/support/nested/permitted.ts': "import '../json.js'\n",
  'src/domain/nested/violates-core.ts': "import '../../core/runtime.js'\n",
  'src/domain/nested/violates-adapters.ts': "import '../../adapters/github/tracker.js'\n",
  'src/domain/nested/permitted.ts': "import '../domain.js'\nimport '../../support/json.js'\n",
  'src/ports/nested/violates-config.ts': "import '../../config/cli-options.js'\n",
  'src/ports/nested/violates-config-allow-listed.ts':
    "import type { Workflow } from '../../config/workflow.js'\n\nexport type W = Workflow\n",
  'src/ports/nested/permitted.ts':
    "import '../../domain/domain.js'\nimport '../../support/json.js'\n",
  'src/core/nested/violates-adapters.ts': "import '../../adapters/github/tracker.js'\n",
  'src/core/nested/permitted.ts':
    "import '../runtime.js'\nimport '../../domain/domain.js'\nimport '../../support/json.js'\n",
}

const isViolation = (path: string): boolean => path.includes('violates')

const expectedViolations: readonly string[] = Object.keys(fixtures).filter(isViolation).sort()

const expectedPermitted: readonly string[] = Object.keys(fixtures)
  .filter((path) => !isViolation(path))
  .sort()

type Diagnostic = Readonly<{
  code: string
  severity: string
  filename: string
}>

const isDiagnostic = (value: unknown): value is Diagnostic => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['code'] === 'string' &&
    typeof candidate['severity'] === 'string' &&
    typeof candidate['filename'] === 'string'
  )
}

/** The files oxlint reported as breaking the import direction, read from its JSON report. */
const importDirectionDiagnostics = (report: string): readonly string[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(report)
  } catch {
    // oxlint failed before it produced a report.  Return nothing so the harness guard in
    // `beforeAll` fails with oxlint's own output rather than an opaque parse error.
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return []
  }
  const diagnostics = (parsed as Record<string, unknown>)['diagnostics']
  if (!Array.isArray(diagnostics)) {
    return []
  }
  return diagnostics
    .filter(isDiagnostic)
    .filter(
      (diagnostic) =>
        diagnostic.code === 'eslint(no-restricted-imports)' && diagnostic.severity === 'error',
    )
    .map((diagnostic) => diagnostic.filename)
}

let fixtureRoot = ''
let output = ''
let reported: readonly string[] = []

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'symphony-import-boundaries-'))

  for (const [path, contents] of Object.entries(fixtures)) {
    const target = join(fixtureRoot, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents, 'utf8')
  }

  /*
   * Extend the repository's own configuration rather than copy it, so these assertions fail if the
   * shipped rule is weakened or deleted.  Type-aware linting is switched off for the fixture run
   * only: it would make oxlint look for `oxlint-tsgolint` and a `tsconfig.json` next to the
   * fixtures, and a missing tsgolint makes oxlint exit non-zero having reported nothing at all.
   * `no-restricted-imports` needs no type information.
   */
  writeFileSync(
    join(fixtureRoot, '.oxlintrc.json'),
    `${JSON.stringify(
      { extends: [join(repoRoot, '.oxlintrc.json')], options: { typeAware: false } },
      null,
      2,
    )}\n`,
    'utf8',
  )

  const lint = spawnSync(join(repoRoot, 'node_modules', '.bin', 'oxlint'), ['--format=json'], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  })

  expect(lint.error).toBeUndefined()

  output = `${lint.stdout}${lint.stderr}`
  reported = [...new Set(importDirectionDiagnostics(lint.stdout))].sort()

  // Guard the harness itself.  oxlint exits non-zero for reasons that have nothing to do with the
  // boundary rule — an unreadable configuration, a missing sidecar — and every assertion below
  // would then pass or fail for the wrong reason.
  expect(
    reported.length,
    `oxlint reported no import-direction violations:\n${output}`,
  ).toBeGreaterThan(0)
})

afterAll(() => {
  if (fixtureRoot !== '') {
    rmSync(fixtureRoot, { force: true, recursive: true })
  }
})

describe('module import direction', () => {
  it('reports exactly the deliberate violations', () => {
    expect(reported, output).toStrictEqual(expectedViolations)
  })

  it.each(expectedViolations)('rejects %s', (path) => {
    expect(reported, output).toContain(path)
  })

  it.each(expectedPermitted)('permits %s', (path) => {
    expect(reported, output).not.toContain(path)
  })
})
