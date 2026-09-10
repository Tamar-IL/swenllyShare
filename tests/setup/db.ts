import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type pgTypes from 'pg';
import { createPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';

const RAW_TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PER_RUN = process.env.TEST_DB_PER_RUN === '1';

// Memoizes the per-run database's connection string across every load of this module
// within one `vitest` invocation. `process.env` is a real property of the OS process, so
// it survives Vitest's per-test-file module-registry reset the same way it survives
// across worker threads spawned from this process (each inherits the *current* env at
// spawn time) — the first load to run (in practice: the `globalSetup` import below,
// which Vitest runs before spinning up any worker) creates the database and records its
// URL here; every later load (each worker's `setupFiles` import of this same file, once
// per test file) just reads it back instead of racing to create its own.
const PER_RUN_ENV_KEY = '__SWENLLY_TEST_DB_PER_RUN_URL';

interface PerRunHandle {
  dbName: string;
  maintenanceUrl: string;
}

// Set only by the specific module instance that actually created the per-run database
// (see `ensurePerRunDatabase`) — that is the instance `globalSetup`'s returned teardown
// below closes over, so only it ever calls `dropPerRunDatabase`.
let perRunHandle: PerRunHandle | undefined;

function withDatabaseName(rawUrl: string, dbName: string): string {
  const u = new URL(rawUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * N-9 (docs/reviews/critic-report.md): `fileParallelism: false` only serializes files
 * *within* one `vitest` run — nothing stops two concurrent runs from sharing one
 * `TEST_DATABASE_URL` and wiping each other's fixtures via `truncateAll()`. The critic
 * reproduced 4 phantom failures this way. When `TEST_DB_PER_RUN=1`, this creates a
 * private `swenlly_test_<pid>_<random>` database — on the same server `TEST_DATABASE_URL`
 * points at, via a connection to its `postgres` maintenance database — for this run
 * alone. `process.pid` is real OS-process identity: every worker thread spawned by one
 * `vitest`/`pnpm test` invocation shares it, which is what makes "one run" well-defined
 * even across parallel workers, while two concurrent invocations always get two
 * different pids and therefore two different databases with no extra coordination.
 * Off by default, so the plain single-run path (the shared `swenlly_test` database,
 * exactly as before) is completely unchanged.
 */
async function ensurePerRunDatabase(rawUrl: string): Promise<string> {
  const memoized = process.env[PER_RUN_ENV_KEY];
  if (memoized) return memoized;

  const dbName = `swenlly_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  const maintenanceUrl = withDatabaseName(rawUrl, 'postgres');
  const admin = new pg.Client({ connectionString: maintenanceUrl });
  await admin.connect();
  try {
    // Postgres has no `CREATE DATABASE IF NOT EXISTS` — catch the (extremely unlikely,
    // given the random suffix) duplicate-database race instead.
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    if ((err as { code?: string }).code !== '42P04') throw err;
  } finally {
    await admin.end();
  }

  const url = withDatabaseName(rawUrl, dbName);
  process.env[PER_RUN_ENV_KEY] = url;
  perRunHandle = { dbName, maintenanceUrl };
  return url;
}

async function dropPerRunDatabase(): Promise<void> {
  if (!perRunHandle) return;
  // Close this instance's own pool first so it isn't the thing FORCE has to terminate.
  if (pool) {
    await pool.end().catch(() => undefined);
  }
  const admin = new pg.Client({ connectionString: perRunHandle.maintenanceUrl });
  await admin.connect();
  try {
    // `WITH (FORCE)` (PostgreSQL 13+): terminates any lingering backend connections
    // (e.g. a worker thread whose pool hadn't fully closed yet) instead of DROP DATABASE
    // simply failing on them.
    await admin.query(`DROP DATABASE IF EXISTS "${perRunHandle.dbName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

const TEST_DATABASE_URL: string | undefined =
  RAW_TEST_DATABASE_URL && PER_RUN
    ? await ensurePerRunDatabase(RAW_TEST_DATABASE_URL)
    : RAW_TEST_DATABASE_URL;

let pool: pgTypes.Pool | undefined;

export function hasTestDatabase(): boolean {
  return Boolean(TEST_DATABASE_URL);
}

/** Lazily-created singleton pool against `TEST_DATABASE_URL` (or, with `TEST_DB_PER_RUN=1`,
 * this run's private database — see `ensurePerRunDatabase` above). */
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

// Runs once per test file (vitest setupFiles) — plus once more for the `globalSetup`
// import below, which happens first. `migrate()` is idempotent — it only executes SQL
// for migrations not yet recorded in `schema_migrations` — so calling it from every
// file's setup is cheap and keeps the schema guaranteed current without a fragile
// cross-file "only once" singleton.
if (TEST_DATABASE_URL) {
  await migrate(testPool());
} else {
  // Loud, not silent: a missing TEST_DATABASE_URL should never look like "0 failures".
  console.warn(
    '\n[tests/setup/db.ts] TEST_DATABASE_URL is not set — integration and contract tests ' +
      'will report SKIPPED, not passed. See scripts/README.md.\n',
  );
}

/**
 * Vitest `globalSetup` entry point (wired up for the `integration` project in
 * `vitest.config.ts`) — runs once, in Vitest's own main process, before any worker
 * starts; its returned teardown runs once after every worker for this run has finished.
 * All the per-run-database setup happens as an ordinary side effect of importing this
 * module (above) — including *this* import, which Vitest issues before spinning up
 * workers, so by the time any worker's `setupFiles` import of this same file runs,
 * `PER_RUN_ENV_KEY` is already set and it just reuses that URL instead of racing to
 * create its own. This function's only remaining job is the other half: dropping the
 * per-run database once the whole run is done. A no-op whenever `TEST_DB_PER_RUN` is
 * unset or `TEST_DATABASE_URL` is missing — there is nothing to drop.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  return async () => {
    await dropPerRunDatabase();
  };
}
