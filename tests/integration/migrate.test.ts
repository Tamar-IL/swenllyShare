import { describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool } from '../setup/db.js';
import { migrate } from '../../src/db/migrate.js';

describe.skipIf(!hasTestDatabase())('migrate (idempotency)', () => {
  it('running migrate() again applies nothing new', async () => {
    const pool = testPool();

    const first = await migrate(pool);
    // By the time this test runs, the setup file has already applied everything.
    expect(first.applied).toEqual([]);

    const second = await migrate(pool);
    expect(second.applied).toEqual([]);

    const { rows } = await pool.query('SELECT filename FROM schema_migrations');
    expect(rows.map((r) => r.filename)).toEqual([
      '0001_init.sql',
      '0002_delivery_sending_state.sql',
      '0003_delivery_dispatching_state.sql',
      '0004_delivery_granted_unconfirmed_outcomes.sql',
      '0005_file_expiry_error.sql',
      '0006_quarantine_suppression_and_expiry_mode.sql',
      '0007_expiry_mode_backfill_and_tenant_folders.sql',
    ]);
  });

  it('all ten domain tables plus schema_migrations exist', async () => {
    const pool = testPool();
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tableNames = rows.map((r) => r.table_name);
    for (const expected of [
      'tenants',
      'magic_link_tokens',
      'sessions',
      'files',
      'file_allowlist',
      'drive_copies',
      'inbound_messages',
      'deliveries',
      'rate_limit_counters',
      'jobs',
      'schema_migrations',
    ]) {
      expect(tableNames).toContain(expected);
    }
  });
});

if (!hasTestDatabase()) {
  it.skip('SKIPPED: TEST_DATABASE_URL is not set — see scripts/README.md', () => {});
}
