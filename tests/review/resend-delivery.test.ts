import { describe, expect, it, beforeEach } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { CookieJar, getCsrfToken, signInAsNewTenant } from '../setup/http.js';
import { buildApp } from '../../src/app.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { runPendingJobs } from '../../src/jobs/queue.js';

/**
 * Fix pass 7 (critic-report.md N-2, "no way to resend"): `POST
 * /files/:id/deliveries/:deliveryId/resend`. Covers the four cases the task named:
 * happy path, cross-tenant 404, wrong-outcome 409, and that the enqueued
 * `delivery.fulfill` job actually sends.
 */
describe.skipIf(!hasTestDatabase())('resend delivery', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('happy path: resends a failed delivery — new queued row, same requester/dmarc, job actually sends', async () => {
    const container = buildTestContainer();
    const email = 'resend-happy@example.com';
    const { tenant, file } = await createTenantWithReadyFile(container, email);
    const original = await deliveries.insertTerminal(container.pool, {
      tenantId: tenant.id,
      fileId: file.id,
      requesterAddress: 'requester@example.com',
      outcome: 'failed',
      reason: 'job_dead_lettered',
      dmarc: 'pass',
    });

    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, email);
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);
    const csrfToken = await getCsrfToken(app, jar, `/files/${file.id}`);

    const sentBefore = container.fakes.outboundMail.sent.length;

    const res = await app.inject({
      method: 'POST',
      url: `/files/${file.id}/deliveries/${original.id}/resend`,
      headers: {
        cookie: jar.header(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ _csrf: csrfToken }).toString(),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/files/${file.id}?flash=resent`);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 10 });
    expect(rows).toHaveLength(2);
    const resent = rows.find((r) => r.id !== original.id)!;
    expect(resent.outcome).toBe('queued');
    expect(resent.reason).toBe(`resend_of:${original.id}`);
    expect(resent.requester_address).toBe('requester@example.com');
    expect(resent.dmarc).toBe('pass');

    // The enqueued delivery.fulfill job actually sends.
    await runPendingJobs(container);
    const afterJob = await deliveries.listForFile(container.pool, tenant.id, file.id, {
      limit: 10,
    });
    const resentAfter = afterJob.find((r) => r.id === resent.id)!;
    expect(resentAfter.outcome).toBe('sent');
    expect(container.fakes.outboundMail.sent.length).toBe(sentBefore + 1);
    expect(container.fakes.outboundMail.sent.at(-1)?.to).toBe('requester@example.com');
  });

  it('cross-tenant: a delivery id that belongs to a different tenant 404s, not 403 or success', async () => {
    const container = buildTestContainer();
    const ownerEmail = 'resend-owner@example.com';
    const { tenant: owner, file } = await createTenantWithReadyFile(container, ownerEmail);
    const original = await deliveries.insertTerminal(container.pool, {
      tenantId: owner.id,
      fileId: file.id,
      requesterAddress: 'requester@example.com',
      outcome: 'failed',
      dmarc: 'pass',
    });

    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, 'resend-intruder@example.com');
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);
    // Fetch the CSRF token from a route the intruder CAN reach (their own /files/new) —
    // fetching it from the owner's file page would itself 404 for the intruder, same as
    // every other tenant-scoped GET in this app.
    const csrfToken = await getCsrfToken(app, jar, '/files/new');

    const res = await app.inject({
      method: 'POST',
      url: `/files/${file.id}/deliveries/${original.id}/resend`,
      headers: {
        cookie: jar.header(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ _csrf: csrfToken }).toString(),
    });
    expect(res.statusCode).toBe(404);

    const rows = await deliveries.listForFile(container.pool, owner.id, file.id, { limit: 10 });
    expect(rows).toHaveLength(1); // nothing was created
  });

  it('wrong outcome: a delivery that already succeeded (sent) cannot be resent — 409', async () => {
    const container = buildTestContainer();
    const email = 'resend-wrong-outcome@example.com';
    const { tenant, file } = await createTenantWithReadyFile(container, email);
    const original = await deliveries.insertTerminal(container.pool, {
      tenantId: tenant.id,
      fileId: file.id,
      requesterAddress: 'requester@example.com',
      outcome: 'sent',
      dmarc: 'pass',
    });

    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, email);
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);
    const csrfToken = await getCsrfToken(app, jar, `/files/${file.id}`);

    const res = await app.inject({
      method: 'POST',
      url: `/files/${file.id}/deliveries/${original.id}/resend`,
      headers: {
        cookie: jar.header(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ _csrf: csrfToken }).toString(),
    });
    expect(res.statusCode).toBe(409);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 10 });
    expect(rows).toHaveLength(1); // nothing was created
  });

  it('an unconfirmed delivery IS resendable', async () => {
    const container = buildTestContainer();
    const email = 'resend-unconfirmed@example.com';
    const { tenant, file } = await createTenantWithReadyFile(container, email);
    const original = await deliveries.insertTerminal(container.pool, {
      tenantId: tenant.id,
      fileId: file.id,
      requesterAddress: 'requester@example.com',
      outcome: 'unconfirmed',
      reason: 'crash_no_definite_error',
      dmarc: 'pass',
    });

    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, email);
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);
    const csrfToken = await getCsrfToken(app, jar, `/files/${file.id}`);

    const res = await app.inject({
      method: 'POST',
      url: `/files/${file.id}/deliveries/${original.id}/resend`,
      headers: {
        cookie: jar.header(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ _csrf: csrfToken }).toString(),
    });
    expect(res.statusCode).toBe(302);
  });
});
