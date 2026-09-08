import type pg from 'pg';
import { createPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

let pool: pg.Pool | undefined;

export function hasTestDatabase(): boolean {
  return Boolean(TEST_DATABASE_URL);
}

/** Lazily-created singleton pool against `TEST_DATABASE_URL`. */
export function testPool(): pg.Pool {
  if (!TEST_DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration/contract tests need a real Postgres: ' +
        'run `scripts/dev-db.sh start`, then `export TEST_DATABASE_URL=$(scripts/dev-db.sh url | ' +
        'grep TEST_DATABASE_URL | cut -d= -f2-)` before running `pnpm test:integration`.',
    );
  }
  if (!pool) {
    pool = createPool({ connectionString: TEST_DATABASE_URL, max: 10 });
  }
  return pool;
}

const ALL_TABLES = [
  'deliveries',
  'drive_copies',
  'file_allowlist',
  'files',
  'inbound_messages',
  'jobs',
  'magic_link_tokens',
  'rate_limit_counters',
  'sessions',
  'tenants',
];

/** Call from `beforeEach` in every integration/contract test to start from an empty
 * database — CASCADE handles the FK graph without needing table-by-table ordering. */
export async function truncateAll(): Promise<void> {
  const p = testPool();
  await p.query(`TRUNCATE TABLE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

// Runs once per test file (vitest setupFiles). `migrate()` is idempotent — it only
// executes SQL for migrations not yet recorded in `schema_migrations` — so calling it
// from every file's setup is cheap and keeps the schema guaranteed current without a
// fragile cross-file "only once" singleton.
if (TEST_DATABASE_URL) {
  await migrate(testPool());
} else {
  // Loud, not silent: a missing TEST_DATABASE_URL should never look like "0 failures".
  console.warn(
    '\n[tests/setup/db.ts] TEST_DATABASE_URL is not set — integration and contract tests ' +
      'will report SKIPPED, not passed. See scripts/README.md.\n',
  );
}
