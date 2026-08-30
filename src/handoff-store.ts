import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Effect } from 'effect'

import { HandoffStoreError } from './errors.js'
import type { HandoffSnapshot } from './handoff.js'

const isSnapshot = (value: unknown): value is HandoffSnapshot => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  const states = new Set([
    'merged',
    'closed_without_merge',
    'awaiting_checks',
    'repair_needed',
    'ready_to_merge',
    'merging',
    'intervention_required',
  ])
  return (
    typeof candidate['issueId'] === 'string' &&
    typeof candidate['identifier'] === 'string' &&
    typeof candidate['pullRequestUrl'] === 'string' &&
    typeof candidate['branchName'] === 'string' &&
    typeof candidate['state'] === 'string' &&
    states.has(candidate['state']) &&
    (candidate['headSha'] === null || typeof candidate['headSha'] === 'string') &&
    (candidate['reason'] === null || typeof candidate['reason'] === 'string') &&
    typeof candidate['repairAttempts'] === 'number' &&
    Number.isSafeInteger(candidate['repairAttempts']) &&
    candidate['repairAttempts'] >= 0 &&
    (candidate['reviewRequestedHeadSha'] === undefined ||
      candidate['reviewRequestedHeadSha'] === null ||
      typeof candidate['reviewRequestedHeadSha'] === 'string') &&
    typeof candidate['observedAt'] === 'string' &&
    !Number.isNaN(Date.parse(candidate['observedAt']))
  )
}

const storeError = (operation: 'read' | 'write', path: string, cause: unknown): HandoffStoreError =>
  new HandoffStoreError({
    operation,
    message: `Could not ${operation} handoff store ${path}${cause instanceof Error ? `: ${cause.message}` : ''}`,
    cause,
  })

export const loadHandoffs = (
  path: string,
): Effect.Effect<readonly HandoffSnapshot[], HandoffStoreError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('handoff store root is not an object')
        }
        if (!('version' in parsed) || !('handoffs' in parsed)) {
          throw new Error('handoff store is missing version or handoffs')
        }
        const handoffs = parsed.handoffs
        if (parsed.version !== 1 || !Array.isArray(handoffs) || !handoffs.every(isSnapshot)) {
          throw new Error('handoff store has an unsupported version or malformed handoff')
        }
        return handoffs
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
    catch: (cause: unknown) => storeError('read', path, cause),
  })

export const saveHandoffs = (
  path: string,
  handoffs: readonly HandoffSnapshot[],
): Effect.Effect<void, HandoffStoreError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      const temporaryPath = `${path}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, handoffs }, null, 2)}\n`, {
        mode: 0o600,
      })
      await rename(temporaryPath, path)
    },
    catch: (cause: unknown) => storeError('write', path, cause),
  })
