import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

/**
 * The `@codex review` handoff vocabulary.
 *
 * This names a GitHub *code-review provider*, not the agent that authored the change: a pull
 * request written by any runner can still be reviewed by Codex. It is deliberately out of scope
 * here, and listing the files that carry it is what keeps that carve-out explicit rather than
 * letting the check quietly rot into a smaller one.
 */
const handoffReviewVocabulary: readonly string[] = [
  'packages/core/src/domain/handoff.ts',
  'packages/core/src/core/handoff-decision.ts',
  'packages/core/src/core/handoff-reconciliation.ts',
]

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(path)
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })

describe('runner neutrality', (): void => {
  /**
   * The core must not name a backend.
   *
   * The point is not tidiness. The orchestrator used to recognize a session's lifecycle by matching
   * Codex's literal method names, which meant a runner with a different vocabulary would run to
   * completion while the scheduler observed nothing at all — a silent failure, not a loud one. A
   * suite that only proves "Codex still works" cannot catch that, because Codex is what the leak
   * was shaped around; this check and the alien runner in `test/harness/alien-agent-runner.ts` are
   * what actually hold the boundary.
   */
  it('leaves no backend named under packages/core', (): void => {
    const offenders = sourceFiles(join(repoRoot, 'packages/core/src'))
      .map((path) => [relative(repoRoot, path), readFileSync(path, 'utf8')] as const)
      .filter(([path]) => !handoffReviewVocabulary.includes(path))
      .filter(([, source]) => /codex/iu.test(source))
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })

  /** Adding a second backend must stay a one-line change at the composition root. */
  it('names a concrete runner kind in exactly one file outside the adapters', (): void => {
    const offenders = sourceFiles(join(repoRoot, 'src'))
      .map((path) => [relative(repoRoot, path), readFileSync(path, 'utf8')] as const)
      .filter(([path]) => path !== 'src/agent-runners.ts')
      .filter(([, source]) => /adapter-codex/u.test(source))
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })
})
