import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { CookieJar, getCsrfToken, signInAsNewTenant } from '../setup/http.js';
import { buildApp } from '../../src/app.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { files } from '../../src/db/repositories/files.js';
import { tenants } from '../../src/db/repositories/tenants.js';
import { NotFoundError } from '../../src/ports/errors.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { Readable } from 'node:stream';

/**
 * Fix pass 10 — the critic's fifth-pass findings (docs/reviews/critic-report.md):
 *   N-11  a save that does not touch the expiry control must not move `expires_at`
 *   N-12  refused resends are aggregated, not one audit row per click
 *   R-5   a malformed path id is a plain 404, never a 500
 *   N-13  a dead persisted folder id self-heals on the next publish
 */
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDatabase())('fix pass 10', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('N-11: renaming a days-mode file keeps expires_at byte-identical after 25 days', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'n11@example.com');
    const clock = container.fakes.clock;
    const svc = container.services.settings;

    await svc.updateSettings(tenant.id, file.id, { expiryMode: 'days', expiryDays: 30 }, clock);
    const before = (await files.findById(container.pool, tenant.id, file.id))!;
    expect(before.expiry_mode).toBe('days');
    expect(before.expires_at).not.toBeNull();

    clock.advance(25 * DAY_MS);
    // Exactly what the pre-filled form submits when only the name changed.
    await svc.updateSettings(
      tenant.id,
      file.id,
      { displayName: 'renamed.pdf', expiryMode: 'days', expiryDays: 30 },
      clock,
    );
    const after = (await files.findById(container.pool, tenant.id, file.id))!;
    expect(after.display_name).toBe('renamed.pdf');
    expect(after.expires_at!.getTime()).toBe(before.expires_at!.getTime());

    // Changing the day count IS an expiry change and is applied from now.
    await svc.updateSettings(tenant.id, file.id, { expiryMode: 'days', expiryDays: 10 }, clock);
    const changed = (await files.findById(container.pool, tenant.id, file.id))!;
    expect(changed.expiry_days).toBe(10);
    expect(changed.expires_at!.getTime()).toBe(clock.now().getTime() + 10 * DAY_MS);
  });

  it('N-12: 30 refused resends produce one aggregated rate_limited row, not 30', async () => {
    const container = buildTestContainer({ RATE_REQUESTER_PER_HOUR: 1 });
    const { tenant, file } = await createTenantWithReadyFile(container, 'n12@example.com');
    const original = await deliveries.insertTerminal(container.pool, {
      tenantId: tenant.id,
      fileId: file.id,
      requesterAddress: 'requester@example.com',
      outcome: 'failed',
      reason: 'job_dead_lettered',
      dmarc: 'pass',
    });
    const results: string[] = [];
    for (let i = 0; i < 30; i++) {
      const r = await container.services.audit.resendDelivery(tenant.id, file.id, original.id);
      results.push(r.status);
    }
    expect(results.filter((s) => s === 'rate_limited').length).toBeGreaterThanOrEqual(28);
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    const limited = rows.filter((r) => r.outcome === 'rate_limited');
    expect(limited).toHaveLength(1);
    expect(limited[0]!.reason).toBe('resend_rate_limited');
    expect(Number(limited[0]!.suppressed_count)).toBeGreaterThanOrEqual(28);
    // original + the one accepted resend + one aggregate
    expect(rows.length).toBeLessThanOrEqual(3);
  });

  it('R-5: non-UUID path ids are a plain 404 on every tenant-scoped route', async () => {
    const container = buildTestContainer();
    const email = 'r5@example.com';
    await createTenantWithReadyFile(container, email);
    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, email);
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);
    const csrfToken = await getCsrfToken(app, jar, '/files');
    const cookie = jar.header();

    const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
    const post = (url: string) =>
      app.inject({
        method: 'POST',
        url,
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: csrfToken }).toString(),
      });

    expect((await get('/files/not-a-uuid')).statusCode).toBe(404);
    expect((await get('/api/files/not-a-uuid/status')).statusCode).toBe(404);
    expect((await get('/api/files/not-a-uuid/deliveries')).statusCode).toBe(404);
    expect((await post('/files/not-a-uuid/settings')).statusCode).toBe(404);
    expect((await post('/files/not-a-uuid/delete')).statusCode).toBe(404);
    expect((await post('/files/not-a-uuid/deliveries/also-bad/resend')).statusCode).toBe(404);
    const okId = '00000000-0000-4000-8000-000000000000';
    expect((await post(`/files/${okId}/deliveries/also-bad/resend`)).statusCode).toBe(404);
    await app.close();
  });

  it('N-13: a provider NotFound on upload clears the persisted folder id and the retry re-creates it', async () => {
    const container = buildTestContainer();
    const { tenant } = await createTenantWithReadyFile(container, 'n13@example.com');
    const persisted = (await tenants.findById(container.pool, tenant.id))!;
    expect(persisted.zoho_folder_id).not.toBeNull();
    const deadId = persisted.zoho_folder_id!;

    // The provider-side folder is gone: the next upload reports NotFound once.
    const store = container.fakes.fileStore;
    const realUpload = store.upload.bind(store);
    let armed = true;
    store.upload = async (...args: Parameters<typeof realUpload>) => {
      if (armed) {
        armed = false;
        throw new NotFoundError('parent folder not found');
      }
      return realUpload(...args);
    };

    const created = await container.services.files.createStaged({
      tenantId: tenant.id,
      stream: Readable.from(Buffer.from('second')),
      originalName: 'second.pdf',
      mime: 'application/pdf',
    });
    await expect(
      container.services.files.publishFile(tenant.id, created.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    const cleared = (await tenants.findById(container.pool, tenant.id))!;
    expect(cleared.zoho_folder_id).toBeNull();
    expect(store.folders.get(tenant.id)).toBeUndefined();

    // The job's retry re-resolves the folder and publishes.
    await runPendingJobs(container);
    await container.services.files.publishFile(tenant.id, created.id);
    const healed = (await tenants.findById(container.pool, tenant.id))!;
    expect(healed.zoho_folder_id).not.toBeNull();
    expect(healed.zoho_folder_id).not.toBe(deadId);
    const row = (await files.findById(container.pool, tenant.id, created.id))!;
    expect(row.status).toBe('ready');
  });
});
