import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts', 'tests/contract/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/db.ts'],
          // The DB harness serializes truncation between tests; keep it single-threaded
          // per file to avoid cross-test interference on the shared TEST_DATABASE_URL.
          fileParallelism: false,
          hookTimeout: 30_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
