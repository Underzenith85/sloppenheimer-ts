import { defineConfig } from 'vitest/config'

export default defineConfig({
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
