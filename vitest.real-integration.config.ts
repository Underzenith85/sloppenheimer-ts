import { defineConfig } from 'vitest/config'

import { workspaceSourceAliases } from './vitest.shared.js'

export default defineConfig({
  resolve: { alias: workspaceSourceAliases },
  test: {
    include: ['test/real-integration/**/*.integration.test.ts'],
    testTimeout: 120_000,
  },
})
