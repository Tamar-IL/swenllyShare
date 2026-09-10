import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool } from '../setup/db.js';

/**
 * Fix pass 8 (docs/reviews/code-review.md, "Polish pass review — 2026-09-10" finding 1),
 * migration `0007_expiry_mode_backfill_and_tenant_folders.sql`.
 *
 * Migration 0006 added `files.expiry_mode NOT NULL DEFAULT 'none'` with no backfill
 * `UPDATE`, so Postgres's fast-default machinery filled every PRE-EXISTING row —
 * including every file that already has a real `expires_at` (the common case: every
 * file gets a `DEFAULT_EXPIRY_DAYS` expiry unless the sender explicitly turned it off)
 * — with the literal default, `'none'`, regardless of the row's actual expiry. Migration
 * 0007 backfills the honest guess (`'custom'`) for any row that already has a real
 * expiry, and leaves a genuinely-`none` row (`expires_at IS NULL`) untouched.
 *
 * Replaces `tests/review/expiry-mode-migration-backfill.probe.test.ts` (deleted): same
 * scratch-database technique (seed a database that looks exactly like data from before
 * 0007 shipped — migrations 0001-0006 applied, then rows inserted, then 0007 applied on
 * top), now asserting the FIXED behavior (`it`, not `it.fails`).
 */
describe.skipIf(!hasTestDatabase())('migration 0007: expiry_mode backfill', () => {
  it('a pre-existing file with a real expiry gets expiry_mode=custom; one with no expiry stays none', async () => {
    const base = testPool().options as unknown as { connectionString?: string };
    const rawUrl =
      base.connectionString ??
      (() => {
        throw new Error('no connection string on test pool');
      })();
    const maintenanceUrl = new URL(rawUrl);
    maintenanceUrl.pathname = '/postgres';

    const dbName = `swenlly_probe_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: maintenanceUrl.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    const probeUrl = new URL(rawUrl);
    probeUrl.pathname = `/${dbName}`;
    const client = new pg.Client({ connectionString: probeUrl.toString() });
    await client.connect();
    try {
      const dir = path.join(process.cwd(), 'src', 'db', 'migrations');
      const preExisting = [
        '0001_init.sql',
        '0002_delivery_sending_state.sql',
        '0003_delivery_dispatching_state.sql',
        '0004_delivery_granted_unconfirmed_outcomes.sql',
        '0005_file_expiry_error.sql',
        '0006_quarantine_suppression_and_expiry_mode.sql',
      ];
      for (const f of preExisting) {
        await client.query(await readFile(path.join(dir, f), 'utf8'));
      }

      const t = await client.query(
        `INSERT INTO tenants (slug, email) VALUES ('probe01', 'probe@example.com') RETURNING id`,
      );
      const tenantId = t.rows[0].id;
      // A pre-0007 file with a real, future expiry — exactly what 0006's fast-default
      // left as the self-contradictory `expiry_mode='none'` + a set `expires_at`.
      await client.query(
        `INSERT INTO files
           (tenant_id, display_name, original_name, size_bytes, mime,
            request_token, public_slug, expires_at, status)
         VALUES ($1, 'expiring.txt', 'expiring.txt', 100, 'text/plain',
                 'tok1234567890123456789012aa', 'slug1234567890123456789012bb',
                 now() + interval '30 days', 'ready')`,
        [tenantId],
      );
      // A pre-0007 file that genuinely has no expiry — must stay 'none', not get
      // swept into 'custom' by an over-broad backfill.
      await client.query(
        `INSERT INTO files
           (tenant_id, display_name, original_name, size_bytes, mime,
            request_token, public_slug, expires_at, status)
         VALUES ($1, 'forever.txt', 'forever.txt', 100, 'text/plain',
                 'tok2234567890123456789012aa', 'slug2234567890123456789012bb',
                 NULL, 'ready')`,
        [tenantId],
      );

      await client.query(
        await readFile(path.join(dir, '0007_expiry_mode_backfill_and_tenant_folders.sql'), 'utf8'),
      );

      const { rows } = await client.query<{
        display_name: string;
        expiry_mode: string;
        expires_at: Date | null;
      }>('SELECT display_name, expiry_mode, expires_at FROM files ORDER BY display_name');

      const expiring = rows.find((r) => r.display_name === 'expiring.txt');
      expect(expiring?.expires_at).not.toBeNull();
      expect(expiring?.expiry_mode).toBe('custom');

      const forever = rows.find((r) => r.display_name === 'forever.txt');
      expect(forever?.expires_at).toBeNull();
      expect(forever?.expiry_mode).toBe('none');

      // The same migration also adds the two nullable tenant-folder columns (finding 2)
      // — confirm they exist and default to NULL for a pre-existing tenant.
      const { rows: tenantRows } = await client.query<{
        zoho_folder_id: string | null;
        drive_folder_id: string | null;
      }>('SELECT zoho_folder_id, drive_folder_id FROM tenants WHERE id = $1', [tenantId]);
      expect(tenantRows[0]?.zoho_folder_id).toBeNull();
      expect(tenantRows[0]?.drive_folder_id).toBeNull();
    } finally {
      await client.end();
      const admin2 = new pg.Client({ connectionString: maintenanceUrl.toString() });
      await admin2.connect();
      await admin2.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin2.end();
    }
  });
});
