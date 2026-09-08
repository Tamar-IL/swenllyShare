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
          include: [
            'tests/integration/**/*.test.ts',
            'tests/contract/**/*.test.ts',
            // Red-team regression cases (docs/security/red-team-report.md). Same harness,
            // same real-Postgres setup as the integration suite.
            'tests/redteam/**/*.test.ts',
          ],
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
