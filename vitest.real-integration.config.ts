import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/real-integration/**/*.integration.test.ts'],
    testTimeout: 120_000,
  },
})
