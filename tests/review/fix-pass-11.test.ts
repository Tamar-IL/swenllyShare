import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { CookieJar, signInAsNewTenant } from '../setup/http.js';
import { buildApp } from '../../src/app.js';
import { files } from '../../src/db/repositories/files.js';

/**
 * Fix pass 11 — the critic's sixth-pass minors (docs/reviews/critic-report.md):
 *   N-14  re-submitting a custom-mode date must not truncate the stored time-of-day
 *   N-15  the deliveries API establishes ownership (foreign / unknown id ⇒ 404)
 *   N-16  the database pairs expiry_mode='days' with a positive expiry_days
 */
describe.skipIf(!hasTestDatabase())('fix pass 11', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('N-14: saving a custom-mode file with the same calendar date keeps the stored timestamp', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'n14@example.com');
    const clock = container.fakes.clock;
    // A backfilled row: custom mode with a non-midnight timestamp.
    const stored = new Date('2026-10-20T06:08:53.364Z');
    await files.updateSettings(container.pool, tenant.id, file.id, {
      expiresAt: stored,
      expiryMode: 'custom',
      expiryDays: null,
    });
    // What the pre-filled <input type="date"> submits: the UTC calendar day only.
    await container.services.settings.updateSettings(
      tenant.id,
      file.id,
      { displayName: 'renamed.pdf', expiryMode: 'custom', expiresAt: new Date('2026-10-20') },
      clock,
    );
    const after = (await files.findById(container.pool, tenant.id, file.id))!;
    expect(after.expires_at!.toISOString()).toBe(stored.toISOString());

    // A different date IS a change and is applied.
    await container.services.settings.updateSettings(
      tenant.id,
      file.id,
      { expiryMode: 'custom', expiresAt: new Date('2026-11-01') },
      clock,
    );
    const changed = (await files.findById(container.pool, tenant.id, file.id))!;
    expect(changed.expires_at!.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('N-15: the deliveries API returns 404 for a foreign or unknown file id, not an empty 200', async () => {
    const container = buildTestContainer();
    const { file: foreign } = await createTenantWithReadyFile(container, 'n15-a@example.com');
    const email = 'n15-b@example.com';
    const { file: own } = await createTenantWithReadyFile(container, email);
    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, email);
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);
    const get = (id: string) =>
      app.inject({
        method: 'GET',
        url: `/api/files/${id}/deliveries`,
        headers: { cookie: jar.header() },
      });
    expect((await get(own.id)).statusCode).toBe(200);
    expect((await get(foreign.id)).statusCode).toBe(404);
    expect((await get('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    await app.close();
  });

  it("N-16: the database refuses expiry_mode='days' without a positive expiry_days", async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'n16@example.com');
    await expect(
      container.pool.query(
        `UPDATE files SET expiry_days = NULL WHERE id = $1 AND expiry_mode = 'days'`,
        [file.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      container.pool.query(`UPDATE files SET expiry_mode = 'none' WHERE id = $1`, [file.id]),
    ).rejects.toMatchObject({ code: '23514' });
    const row = (await files.findById(container.pool, tenant.id, file.id))!;
    expect(row.expiry_mode).toBe('days');
    expect(row.expiry_days).toBeGreaterThan(0);
  });
});
