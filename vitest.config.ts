import { defineConfig } from 'vitest/config';

// Real browser + a real (child-process) server on a real port: the `e2e` project must
// never run as a side effect of a plain `pnpm test`/`vitest run` — only when a developer
// or CI explicitly opts in with `E2E=1`. Leaving the project entry out of `projects`
// entirely (rather than just excluding its files) means a bare `pnpm test` never even
// sees an "e2e" project — no "no test files found" noise, and no risk of it picking up
// `tests/e2e/**` some other way.
const E2E_ENABLED = process.env.E2E === '1';

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
            // QA regression cases (docs/qa/qa-report-sender-app.md). Same harness.
            'tests/qa/**/*.test.ts',
            // Code-review verification pins (docs/reviews/code-review.md). Same harness.
            'tests/review/**/*.test.ts',
          ],
          environment: 'node',
          setupFiles: ['tests/setup/db.ts'],
          // N-9 (docs/reviews/critic-report.md): also loads tests/setup/db.ts, but through
          // Vitest's separate globalSetup mechanism — runs once in the main process before
          // any worker starts (and its teardown once after they all finish), which is what
          // lets it create/drop one shared per-run database (TEST_DB_PER_RUN=1) instead of
          // racing every worker to do it. See that file's `ensurePerRunDatabase` doc comment.
          globalSetup: ['tests/setup/db.ts'],
          // The DB harness serializes truncation between tests; keep it single-threaded
          // per file to avoid cross-test interference on the shared TEST_DATABASE_URL.
          fileParallelism: false,
          hookTimeout: 30_000,
          testTimeout: 30_000,
        },
      },
      ...(E2E_ENABLED
        ? [
            {
              test: {
                name: 'e2e',
                include: ['tests/e2e/**/*.e2e.ts'],
                environment: 'node',
                hookTimeout: 60_000,
                testTimeout: 60_000,
              },
            },
          ]
        : []),
    ],
  },
});
