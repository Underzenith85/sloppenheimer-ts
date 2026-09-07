import { describe, expect, it } from 'vitest'
import type { Aggregate } from '@sloppenheimer/coordinator-contracts'
import { scenarioFixtures } from '@sloppenheimer/coordinator-contracts/fixtures.js'
import { workKey } from '@sloppenheimer/coordinator-contracts/common.js'

describe('browser shared contract fixtures', () => {
  it('supplies distinct fleet rows without host or React dependencies', () => {
    const aggregate: Aggregate | undefined = scenarioFixtures()['duplicateNumbers']
    expect(aggregate?.items).toHaveLength(2)
    expect(new Set(aggregate?.items.map((item) => workKey(item.identity))).size).toBe(2)
  })
})
