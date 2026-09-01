import { it } from '@effect/vitest'
import { Clock, Effect, TestClock } from 'effect'
import { describe, expect } from 'vitest'

import { issueId, issueIdentifier, type Issue } from '@sloppenheimer/core/domain/domain.js'
import { FakeTracker } from '../harness/fake-tracker.js'
import { FakeWorkspaceProcess } from '../harness/fake-workspace-process.js'
import { anIssue } from '../harness/fixtures.js'

const issue: Issue = anIssue({
  id: issueId('opaque-1'),
  identifier: issueIdentifier('owner/repository#1'),
  title: 'Conformance fixture',
  nativeRef: { number: 1 },
  priority: 1,
  state: 'Open',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
})

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

  it.effect(
    'implements per-run workspace allocation, hooks, release and removal without host IO',
    () =>
      Effect.gen(function* () {
        const workspaces = new FakeWorkspaceProcess()
        const published = yield* workspaces.withLeasedWorkspace(
          { identifier: issue.identifier, runId: 1 },
          (workspace) => Effect.succeed(workspace),
          () => ({ _tag: 'Completed' }),
        )
        const failed = yield* workspaces.withLeasedWorkspace(
          { identifier: issue.identifier, runId: 2 },
          (workspace) =>
            workspaces
              .beforeRun(workspace)
              .pipe(Effect.zipRight(workspaces.afterRun(workspace)), Effect.as(workspace)),
          () => ({ _tag: 'Retained', reason: 'run failed' }),
        )
        yield* workspaces.remove(issue.identifier)

        // Two runs of one issue never share a directory, and only the run that published lets go
        // of its own without leaving a recovery artifact behind.
        expect(failed.path).not.toBe(published.path)
        expect(workspaces.operations.map((operation) => operation.operation)).toEqual([
          'acquire',
          'release',
          'acquire',
          'beforeRun',
          'afterRun',
          'release',
          'remove',
        ])
        expect(
          workspaces.operations.filter((operation) => operation.release !== null),
        ).toMatchObject([{ release: { _tag: 'Completed' } }, { release: { _tag: 'Retained' } }])
      }),
  )
})
