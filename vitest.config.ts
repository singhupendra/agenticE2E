import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // SPEC-010 FR-11: thresholds = measured baseline (lines 95.4, statements 92.1, branches 84.2, functions 90.0) minus a margin.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'html', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      thresholds: { lines: 93, statements: 90, branches: 82, functions: 88 },
    },
  },
});
