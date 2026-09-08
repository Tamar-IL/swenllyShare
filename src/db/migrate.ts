import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { createPool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `.sql` files are not compiled/copied by `tsc` (build = plain tsc, no asset step), so
// this always points at the source tree's migrations directory — two levels up from
// this module's own directory lands at the repo root whether this runs as
// `src/db/migrate.ts` (via tsx) or as the compiled `dist/db/migrate.js`, since both
// live at the same `<root>/{src,dist}/db/` depth. The single-deployable model
// (architecture.md §1) ships the full repo, not a dist-only artifact, so `src/` is
// always present on disk next to `dist/`.
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');

async function ensureMigrationsTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedFilenames(pool: pg.Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

async function pendingMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Applies every `.sql` file under `src/db/migrations/` that is not yet recorded in
 * `schema_migrations`, each in its own transaction, in filename order. Idempotent:
 * running it again with nothing new to apply is a no-op. Safe to call concurrently
 * from multiple processes — each migration's transaction plus the `schema_migrations`
 * primary key means a losing racer's insert fails and it simply stops.
 */
export async function migrate(pool: pg.Pool): Promise<{ applied: string[] }> {
  await ensureMigrationsTable(pool);
  const already = await appliedFilenames(pool);
  const files = await pendingMigrationFiles();
  const applied: string[] = [];

  for (const filename of files) {
    if (already.has(filename)) continue;
    const fullPath = path.join(MIGRATIONS_DIR, filename);
    const sql = await readFile(fullPath, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      applied.push(filename);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${filename} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }

  return { applied };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required to run migrations');
    process.exit(1);
  }
  const pool = createPool({ connectionString: databaseUrl });
  try {
    const { applied } = await migrate(pool);
    if (applied.length === 0) {
      console.log('migrate: nothing to apply, schema is up to date');
    } else {
      console.log(`migrate: applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }
  } finally {
    await pool.end();
  }
}

// Only run as a CLI when this file is the process entry point, not when imported.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
