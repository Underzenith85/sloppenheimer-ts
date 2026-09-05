import { defineConfig } from 'vitest/config'

import { workspaceSourceAliases } from './vitest.shared.js'

export default defineConfig({
  resolve: { alias: workspaceSourceAliases },
  test: {
    coverage: {
      include: ['src/**/*.ts', 'packages/*/src/**/*.{ts,tsx}'],
      provider: 'v8',
    },
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['test/real-integration/**'],
  },
})
