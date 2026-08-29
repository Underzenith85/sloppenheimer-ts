import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Effect } from 'effect'

import type { HandoffSnapshot } from './handoff.js'

const isSnapshot = (value: unknown): value is HandoffSnapshot => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['issueId'] === 'string' &&
    typeof candidate['identifier'] === 'string' &&
    typeof candidate['pullRequestUrl'] === 'string' &&
    typeof candidate['branchName'] === 'string' &&
    typeof candidate['state'] === 'string' &&
    (candidate['headSha'] === null || typeof candidate['headSha'] === 'string') &&
    (candidate['reason'] === null || typeof candidate['reason'] === 'string') &&
    typeof candidate['repairAttempts'] === 'number' &&
    typeof candidate['observedAt'] === 'string'
  )
}

export const loadHandoffs = (path: string): Effect.Effect<readonly HandoffSnapshot[]> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return []
        }
        if (!('version' in parsed) || !('handoffs' in parsed)) {
          return []
        }
        const handoffs = parsed.handoffs
        return parsed.version === 1 && Array.isArray(handoffs) && handoffs.every(isSnapshot)
          ? handoffs
          : []
      } catch (cause: unknown) {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'ENOENT'
        ) {
          return []
        }
        throw cause
      }
    },
    catch: () => [],
  }).pipe(Effect.catchAll(() => Effect.succeed([])))

export const saveHandoffs = (
  path: string,
  handoffs: readonly HandoffSnapshot[],
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      const temporaryPath = `${path}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, handoffs }, null, 2)}\n`, {
        mode: 0o600,
      })
      await rename(temporaryPath, path)
    },
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.void))
