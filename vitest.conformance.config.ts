import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [
      'test/real-integration/**',
      'test/extension-conformance/**',
      'test/github-handoff.test.ts',
      'test/handoff.test.ts',
      'test/handoff-store.test.ts',
    ],
  },
})
