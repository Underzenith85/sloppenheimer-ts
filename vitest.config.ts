import { defineConfig } from 'vitest/config'

import { workspaceSourceAliases } from './vitest.shared.js'

export default defineConfig({
  resolve: { alias: workspaceSourceAliases },
  test: {
    coverage: {
      include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
      provider: 'v8',
    },
    include: ['test/**/*.test.ts'],
    exclude: ['test/real-integration/**'],
  },
})
