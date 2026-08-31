import { it } from '@effect/vitest'
import { Clock, Effect, TestClock } from 'effect'
import { describe, expect } from 'vitest'

import { issueId, issueIdentifier, type Issue } from '../../src/domain/domain.js'
import { FakeTracker } from '../harness/fake-tracker.js'
import { FakeWorkspaceProcess } from '../harness/fake-workspace-process.js'

const issue: Issue = {
  id: issueId('opaque-1'),
  nativeRef: { number: 1 },
  identifier: issueIdentifier('owner/repository#1'),
  title: 'Conformance fixture',
  description: null,
  priority: 1,
  state: 'Open',
  branchName: null,
  url: null,
  assigneeId: null,
  labels: ['symphony'],
  blockedBy: [],
  dispatchable: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: null,
}

describe('Core Conformance typed harness boundaries', (): void => {
  it.effect('advances scheduled work deterministically in due-time order', () => {
    const events: string[] = []
    const record = (label: string, delayMs: number): Effect.Effect<void> =>
      Effect.sleep(delayMs).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            events.push(label)
          }),
        ),
      )

    return Effect.gen(function* () {
      yield* TestClock.adjust(1_000)
      yield* Effect.fork(record('last', 30))
      yield* Effect.fork(record('first', 10))
      yield* Effect.fork(record('second', 20))
      // One advance drains every sleep it passes, in due order, without waiting on wall time.
      yield* TestClock.adjust(30)

      expect(yield* Clock.currentTimeMillis).toBe(1_030)
      expect(events).toEqual(['first', 'second', 'last'])
    })
  })

  it.effect('implements the exact tracker adapter boundary and records typed calls', () =>
    Effect.gen(function* () {
      const tracker = new FakeTracker([issue], ['FAKE_TRACKER_TOKEN'])

      const selected = yield* tracker.fetchIssuesByStates([' open '], null)
      const refreshed = yield* tracker.fetchIssuesByIds([issue.id])

      expect(selected).toEqual([issue])
      expect(refreshed).toEqual([issue])
      expect(tracker.calls.map((call) => call.operation)).toEqual([
        'fetchIssuesByStates',
        'fetchIssuesByIds',
      ])
    }),
  )

  it.effect('implements workspace creation, reuse, hooks, and removal without host IO', () =>
    Effect.gen(function* () {
      const workspaces = new FakeWorkspaceProcess()
      const first = yield* workspaces.create(issue.identifier)
      const second = yield* workspaces.create(issue.identifier)
      yield* workspaces.beforeRun(second)
      yield* workspaces.afterRun(second)
      yield* workspaces.remove(issue.identifier)

      expect(first.createdNow).toBe(true)
      expect(second.createdNow).toBe(false)
      expect(workspaces.operations.map((operation) => operation.operation)).toEqual([
        'create',
        'create',
        'beforeRun',
        'afterRun',
        'remove',
      ])
    }),
  )
})
