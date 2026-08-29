import { describe, expect, it } from 'vitest'

import { issueId, issueIdentifier, type BlockerRef, type Issue } from '../src/domain.js'
import { buildBacklogSnapshot } from '../src/operator.js'

const blocker = (number: number, state = 'open'): BlockerRef => ({
  id: String(10_000 + number),
  identifier: issueIdentifier(`example/symphony#${String(number)}`),
  title: `Issue ${String(number)}`,
  state,
  url: `https://github.com/example/symphony/issues/${String(number)}`,
})

const issue = (number: number, blockers: readonly BlockerRef[] = []): Issue => ({
  id: issueId(String(number)),
  nativeRef: null,
  identifier: issueIdentifier(`example/symphony#${String(number)}`),
  title: `Issue ${String(number)}`,
  description: null,
  priority: null,
  state: 'open',
  branchName: null,
  url: `https://github.com/example/symphony/issues/${String(number)}`,
  assigneeId: null,
  labels: [],
  blockedBy: blockers,
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
})

describe('operator dependency graph', (): void => {
  it('builds deterministic nodes and blocker-to-dependent edges for mixed graph shapes', (): void => {
    const snapshot = buildBacklogSnapshot(
      [
        issue(1),
        issue(2, [blocker(1)]),
        issue(3, [blocker(1)]),
        issue(4, [blocker(2), blocker(3)]),
        issue(5),
      ],
      'symphony',
      ['closed'],
    )

    expect(snapshot.nodes.map((node) => node.identifier)).toEqual([
      'example/symphony#1',
      'example/symphony#2',
      'example/symphony#3',
      'example/symphony#4',
      'example/symphony#5',
    ])
    expect(snapshot.edges).toEqual([
      { blocker: 'example/symphony#1', dependent: 'example/symphony#2' },
      { blocker: 'example/symphony#1', dependent: 'example/symphony#3' },
      { blocker: 'example/symphony#2', dependent: 'example/symphony#4' },
      { blocker: 'example/symphony#3', dependent: 'example/symphony#4' },
    ])
    expect(snapshot.issues.map(({ number, readiness }) => [number, readiness])).toEqual([
      [1, 'ready'],
      [2, 'blocked'],
      [3, 'blocked'],
      [4, 'blocked'],
      [5, 'ready'],
    ])
  })

  it('exposes cycle diagnostics and completed external blockers', (): void => {
    const snapshot = buildBacklogSnapshot(
      [issue(6, [blocker(7)]), issue(7, [blocker(6)]), issue(8, [blocker(9, 'closed')])],
      'symphony',
      ['closed'],
    )

    expect(snapshot.cycles).toHaveLength(1)
    expect(snapshot.issues.find(({ number }) => number === 6)?.readiness).toBe('cyclic')
    expect(snapshot.issues.find(({ number }) => number === 7)?.readiness).toBe('cyclic')
    expect(snapshot.issues.find(({ number }) => number === 8)?.readiness).toBe('ready')
    expect(snapshot.nodes.find(({ identifier }) => identifier.endsWith('#9'))?.readiness).toBe(
      'completed',
    )
  })
})
