import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'out/**', 'dist/**', 'artifacts/**'],
    restoreMocks: true,
    // The Intel macOS runner has few cores; starting 100+ isolated workers
    // starves socket/timer tests. CI sets this to a small fixed pool.
    maxWorkers: process.env.VITEST_MAX_WORKERS
      ? Number(process.env.VITEST_MAX_WORKERS)
      : undefined
  }
})
