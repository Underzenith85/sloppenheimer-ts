import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

/**
 * Fixture modules laid out like the workspace, each one either a deliberate violation of the import
 * direction or the permitted case that must stay quiet.  Linting them with the repository's own
 * `.oxlintrc.json` is what proves the rule fires; asserting on the rule text alone would not.
 *
 * The targets need not exist: `no-restricted-imports` matches the specifier as written.
 */
const fixtures: Readonly<Record<string, string>> = {
  'packages/coordinator-ui/src/violates-host.tsx': "import '@sloppenheimer/adapter-node'\n",
  'packages/coordinator-ui/src/violates-node.ts': "import 'node:fs'\n",
  'packages/coordinator-ui/src/permitted.tsx': "import 'react'\nimport './app.js'\n",
  'src/violates-coordinator.ts': "import '../packages/coordinator-ui/src/app.js'\n",
  'src/violates-react.ts': "import 'react'\n",
  'packages/adapter-node/src/violates-react.ts': "import 'react-dom/client'\n",

  // support/ is the bottom layer and may reach nothing above it.
  'packages/core/src/support/violates-domain.ts': "import '../domain/domain.js'\n",
  'packages/core/src/support/violates-package-root.ts': "import '../telemetry.js'\n",
  'packages/core/src/support/violates-adapter-package.ts':
    "import '@sloppenheimer/adapter-github/issues.js'\n",
  'packages/core/src/support/permitted.ts': "import 'node:path'\nimport './json.js'\n",

  // domain/ may use support/ and nothing else.
  'packages/core/src/domain/violates-core.ts': "import '../core/runtime.js'\n",
  'packages/core/src/domain/violates-ports.ts': "import '../ports/tracker.js'\n",
  'packages/core/src/domain/violates-config.ts': "import '../config/workflow.js'\n",
  'packages/core/src/domain/violates-package-root.ts': "import '../telemetry.js'\n",
  'packages/core/src/domain/violates-adapter-package.ts':
    "import '@sloppenheimer/adapter-codex/codex.js'\n",
  'packages/core/src/domain/permitted.ts': "import '../support/json.js'\nimport './errors.js'\n",
  // #109 retired the error vocabulary's entry by moving it into domain/, where the containment
  // rules #91 put here reach it as a sibling rather than through an exemption.
  'packages/core/src/domain/violates-retired-errors-allow-list.ts':
    "import { WorkspaceError } from '../errors.js'\n\nexport const reject = WorkspaceError\n",

  // ports/ may use domain/ and support/ and nothing else.
  'packages/core/src/ports/violates-config.ts': "import '../config/env-reference.js'\n",
  'packages/core/src/ports/violates-core.ts': "import '../core/runtime.js'\n",
  'packages/core/src/ports/violates-adapter-package.ts':
    "import '@sloppenheimer/adapter-github/issues.js'\n",
  'packages/core/src/ports/permitted.ts':
    "import '../domain/domain.js'\nimport '../support/json.js'\n",
  // The migration allow-list keeps the vocabulary #88 declared the ports against reachable, but
  // only as types: a port must not acquire a runtime dependency on configuration or on the
  // package root under cover of the exemption.
  'packages/core/src/ports/permitted-allow-list.ts':
    "import type { Workflow } from '../config/workflow.js'\nimport type { AgentEvent } from '../telemetry.js'\n\nexport type Vocabulary = [Workflow, AgentEvent]\n",
  // #94 retired the tracker-configuration entry: the validated tracker selection is domain
  // vocabulary now, so a port reaches it through domain/ rather than through configuration.
  'packages/core/src/ports/violates-retired-tracker-config-allow-list.ts':
    "import type { ValidatedTrackerProvider } from '../config/tracker-config.js'\n\nexport type V = ValidatedTrackerProvider\n",
  // #109 retired the error and host-tool entries the same way, by moving both into domain/.
  'packages/core/src/ports/violates-retired-errors-allow-list.ts':
    "import type { TrackerError } from '../errors.js'\n\nexport type E = TrackerError\n",
  'packages/core/src/ports/violates-retired-host-tools-allow-list.ts':
    "import type { HostToolSpec } from '../host-tools.js'\n\nexport type S = HostToolSpec\n",
  'packages/core/src/ports/violates-allow-list-value.ts':
    "import { renderPrompt } from '../config/workflow.js'\n\nexport const render = renderPrompt\n",
  'packages/core/src/ports/violates-allow-list-side-effect.ts': "import '../telemetry.js'\n",

  // core/ holds policy and may not name a concrete adapter.  This is the drift the rule exists to
  // stop: the orchestration policy importing `makeGitHubTracker` by name.  The adapter package is
  // also absent from `packages/core/package.json`, so this does not resolve either.
  'packages/core/src/core/violates-adapter-package.ts':
    "import { makeGitHubTracker } from '@sloppenheimer/adapter-github/issues.js'\n\nexport const bound = makeGitHubTracker\n",
  'packages/core/src/core/violates-adapter-package-reexport.ts':
    "export * from '@sloppenheimer/adapter-github/issues.js'\n",
  'packages/core/src/core/violates-adapter-package-dynamic.ts':
    "export const load = async (): Promise<unknown> => import('@sloppenheimer/adapter-codex/codex.js')\n",
  'packages/core/src/core/permitted.ts':
    "import '../config/workflow.js'\nimport '../domain/domain.js'\nimport '../domain/errors.js'\nimport '../ports/tracker.js'\nimport '../support/json.js'\n",
  // The migration allow-list keeps telemetry, the one module still at the core package root,
  // reachable from core/.
  'packages/core/src/core/permitted-allow-list.ts': "import '../telemetry.js'\n",
  // #89 retired Codex's entry: the backend now lives in its own package behind the agent-runner
  // port, so a package-root module of that name is no longer something core may reach for.
  'packages/core/src/core/violates-retired-codex-allow-list.ts': "import '../codex.js'\n",
  // #90 retired the tracker's entry for the same reason: the GitHub tracker and code-review
  // implementations now live in the GitHub adapter package behind their ports.
  'packages/core/src/core/violates-retired-tracker-allow-list.ts': "import '../tracker.js'\n",
  // #91 retired the workspace entry the same way: the manager and the hooks live in the Node
  // adapter package, and the containment rules core still calls moved down into domain/.
  'packages/core/src/core/violates-retired-workspace-allow-list.ts': "import '../workspace.js'\n",
  // #109 retired the last three: the error and host-tool vocabulary moved into domain/, and the
  // handoff store moved into core/ beside the runtime that is its only caller.
  'packages/core/src/core/violates-retired-errors-allow-list.ts': "import '../errors.js'\n",
  'packages/core/src/core/violates-retired-host-tools-allow-list.ts': "import '../host-tools.js'\n",
  'packages/core/src/core/violates-retired-handoff-store-allow-list.ts':
    "import '../handoff-store.js'\n",

  // The adapter packages are restricted as an import target, never as a source, and the root
  // application is the composition root that deliberately binds them.
  'packages/adapter-github/src/permitted.ts':
    "import '@sloppenheimer/core'\nimport '@sloppenheimer/core/ports/tracker.js'\n",
  'src/composition-root.ts':
    "import '@sloppenheimer/adapter-github'\nimport '@sloppenheimer/core'\n",

  /*
   * Nested modules.  The layers are flat today, but a rule that rejects a compliant directory
   * refactor would block the restructuring issues under #76 rather than guard them, so a nested
   * module must still be denied the layers above it and must keep its same-layer and lower-layer
   * imports.  These specifiers carry an extra `../` that the depth-one patterns do not match.
   */
  'packages/core/src/support/nested/violates-domain.ts': "import '../../domain/domain.js'\n",
  'packages/core/src/support/nested/permitted.ts': "import '../json.js'\n",
  'packages/core/src/domain/nested/violates-core.ts': "import '../../core/runtime.js'\n",
  'packages/core/src/domain/nested/violates-adapter-package.ts':
    "import '@sloppenheimer/adapter-github/issues.js'\n",
  'packages/core/src/domain/nested/permitted.ts':
    "import '../domain.js'\nimport '../../support/json.js'\n",
  'packages/core/src/ports/nested/violates-config.ts': "import '../../config/env-reference.js'\n",
  'packages/core/src/ports/nested/violates-config-allow-listed.ts':
    "import type { Workflow } from '../../config/workflow.js'\n\nexport type W = Workflow\n",
  'packages/core/src/ports/nested/permitted.ts':
    "import '../../domain/domain.js'\nimport '../../support/json.js'\n",
  'packages/core/src/core/nested/violates-adapter-package.ts':
    "import '@sloppenheimer/adapter-github/issues.js'\n",
  'packages/core/src/core/nested/permitted.ts':
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
  fixtureRoot = mkdtempSync(join(tmpdir(), 'sloppenheimer-import-boundaries-'))

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
