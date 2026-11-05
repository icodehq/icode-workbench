import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'out/**', 'dist/**', 'artifacts/**'],
    restoreMocks: true,
    // The macOS runners have few cores; starting 100+ isolated workers starves
    // socket/timer tests and real Git operations. CI sets a small fixed pool
    // and a larger per-test budget for those slower files.
    maxWorkers: process.env.VITEST_MAX_WORKERS
      ? Number(process.env.VITEST_MAX_WORKERS)
      : undefined,
    testTimeout: process.env.VITEST_TEST_TIMEOUT
      ? Number(process.env.VITEST_TEST_TIMEOUT)
      : undefined
  }
})
