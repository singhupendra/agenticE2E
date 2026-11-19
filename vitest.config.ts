import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // SPEC-010 FR-11: thresholds = measured baseline (after SPEC-011..014, post-Prettier: lines 95.0, statements 93.4, branches 86.9, functions 92.6) minus a margin.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'html', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      thresholds: { lines: 93, statements: 91, branches: 85, functions: 90 },
    },
  },
});
