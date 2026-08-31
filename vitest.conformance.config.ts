import { defineConfig } from 'vitest/config'

import { workspaceSourceAliases } from './vitest.shared.js'

export default defineConfig({
  resolve: { alias: workspaceSourceAliases },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [
      'test/real-integration/**',
      'test/extension-conformance/**',
      'test/cli.test.ts',
      'test/github-handoff.test.ts',
      'test/domain/handoff.test.ts',
      'test/handoff-store.test.ts',
      'test/installed-codex.integration.test.ts',
      'test/operator/operator.test.ts',
      'test/operator/server.test.ts',
    ],
  },
})
