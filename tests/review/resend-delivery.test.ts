import { describe, expect, it, beforeEach } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { CookieJar, getCsrfToken, signInAsNewTenant } from '../setup/http.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { runPendingJobs } from '../../src/jobs/queue.js';

/**
 * Fix pass 7 (critic-report.md N-2, "no way to resend"): `POST
 * /files/:id/deliveries/:deliveryId/resend`. Covers the four cases the task named:
 * happy path, cross-tenant 404, wrong-outcome 409, and that the enqueued
 * `delivery.fulfill` job actually sends.
 *
 * Fix pass 9 (critic-report.md R-2, "resend routes around the one rate-limit bucket
 * that protects the recipient, and is not idempotent"): the abuse-bound tests below —
 * a double-click storm bounded to one delivery, the shared per-requester rate gate now
 * applying to resends, that gate being genuinely SHARED across files, and proof that
 * none of this touched the inbound pipeline's own (unrelated) duplicate-request
 * behavior.
 */
async function postResend(
  app: FastifyInstance,
  jar: CookieJar,
  fileId: string,
  deliveryId: string,
  csrfToken: string,
) {
  return app.inject({
    method: 'POST',
    url: `/files/${fileId}/deliveries/${deliveryId}/resend`,
    headers: {
      cookie: jar.header(),
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams({ _csrf: csrfToken }).toString(),
  });
}
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

  it('R-2: 12 concurrent resend clicks on the same failed row create exactly one new delivery and send exactly one mail', async () => {
    // Rate gates set generously high so this test isolates the IN-FLIGHT guard
    // (migration 0008's partial unique index) from rate limiting, which is covered on
    // its own below.
    const container = buildTestContainer({
      RATE_REQUESTER_PER_HOUR: 1000,
      RATE_DOMAIN_PER_HOUR: 1000,
      RATE_FILE_PER_HOUR: 1000,
      RATE_TENANT_PER_HOUR: 1000,
    });
    const email = 'resend-concurrent@example.com';
    const { tenant, file } = await createTenantWithReadyFile(container, email);
    const original = await deliveries.insertTerminal(container.pool, {
      tenantId: tenant.id,
      fileId: file.id,
      requesterAddress: 'concurrent-requester@example.com',
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

    const responses = await Promise.all(
      Array.from({ length: 12 }, () => postResend(app, jar, file.id, original.id, csrfToken)),
    );

    const accepted = responses.filter((r) => r.statusCode === 302);
    const refused = responses.filter((r) => r.statusCode === 409);
    expect(accepted).toHaveLength(1); // exactly one click actually created a delivery
    expect(refused).toHaveLength(11); // every other concurrent click was refused in-flight

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 20 });
    expect(rows).toHaveLength(2); // the original row + exactly one resend row
    const resent = rows.find((r) => r.id !== original.id)!;
    expect(resent.reason).toBe(`resend_of:${original.id}`);

    await runPendingJobs(container);
    expect(container.fakes.outboundMail.sent.length).toBe(sentBefore + 1); // exactly one mail
  });

  it('R-2: a 6th resend to the same requester within the hour is rate_limited (429) and writes an audit row', async () => {
    const container = buildTestContainer({ RATE_REQUESTER_PER_HOUR: 5 });
    const email = 'resend-ratelimited@example.com';
    const requesterAddress = 'bombed-recipient@example.com';
    const { tenant, file } = await createTenantWithReadyFile(container, email);
    const original = await deliveries.insertTerminal(container.pool, {
      tenantId: tenant.id,
      fileId: file.id,
      requesterAddress,
      outcome: 'failed',
      dmarc: 'pass',
    });

    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, email);
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);

    // Each of the first 5 resends is let through the rate gate — run its job to
    // completion (queued -> sent) before the next click, so the IN-FLIGHT guard never
    // interferes with this test's own rate-limit assertion.
    for (let i = 0; i < 5; i++) {
      const csrfToken = await getCsrfToken(app, jar, `/files/${file.id}`);
      const res = await postResend(app, jar, file.id, original.id, csrfToken);
      expect(res.statusCode).toBe(302);
      await runPendingJobs(container);
    }

    const csrfToken = await getCsrfToken(app, jar, `/files/${file.id}`);
    const sixth = await postResend(app, jar, file.id, original.id, csrfToken);
    expect(sixth.statusCode).toBe(429);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 20 });
    const rateLimitedRow = rows.find((r) => r.outcome === 'rate_limited');
    expect(rateLimitedRow).toBeDefined();
    expect(rateLimitedRow?.reason).toBe('resend_rate_limited'); // fix pass 10 (N-12): aggregated per file/requester/hour
    expect(rateLimitedRow?.requester_address).toBe(requesterAddress);
  });

  it('R-2: resends to two different files by the same requester share the shared per-requester bucket', async () => {
    const container = buildTestContainer({
      RATE_REQUESTER_PER_HOUR: 3,
      RATE_FILE_PER_HOUR: 1000,
      RATE_DOMAIN_PER_HOUR: 1000,
      RATE_TENANT_PER_HOUR: 1000,
    });
    const email = 'resend-sharedbucket@example.com';
    const requesterAddress = 'cross-file-requester@example.com';
    const { tenant, file: fileA } = await createTenantWithReadyFile(container, email, {
      originalName: 'a.pdf',
    });
    const { file: fileB } = await createTenantWithReadyFile(container, email, {
      originalName: 'b.pdf',
    });
    const originalA = await deliveries.insertTerminal(container.pool, {
      tenantId: tenant.id,
      fileId: fileA.id,
      requesterAddress,
      outcome: 'failed',
      dmarc: 'pass',
    });
    const originalB = await deliveries.insertTerminal(container.pool, {
      tenantId: tenant.id,
      fileId: fileB.id,
      requesterAddress,
      outcome: 'failed',
      dmarc: 'pass',
    });

    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, email);
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);

    async function resend(fileId: string, deliveryId: string) {
      const csrfToken = await getCsrfToken(app, jar, `/files/${fileId}`);
      const res = await postResend(app, jar, fileId, deliveryId, csrfToken);
      await runPendingJobs(container); // clear the in-flight guard before the next attempt
      return res;
    }

    // 3 resends total are allowed across BOTH files (the shared requester bucket, not
    // a per-file one) — the 4th, however it's sliced by file, is rate_limited.
    expect((await resend(fileA.id, originalA.id)).statusCode).toBe(302);
    expect((await resend(fileB.id, originalB.id)).statusCode).toBe(302);
    expect((await resend(fileA.id, originalA.id)).statusCode).toBe(302);
    expect((await resend(fileB.id, originalB.id)).statusCode).toBe(429);
  });

  it("R-2: the resend in-flight guard does not change the inbound pipeline's own (unrelated) duplicate-request behavior", async () => {
    // Migration 0008's unique index is scoped to `reason LIKE 'resend_of:%'` precisely
    // so it never applies to the ordinary inbound webhook path — a second genuine
    // request from the same requester while the first is still queued creates its own
    // row today, and must keep doing so.
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(
      container,
      'resend-inbound-unchanged@example.com',
    );

    const first = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'inbound-duplicate@example.com',
        dmarc: 'pass',
      }),
    );
    expect(first.status).toBe(200);

    const second = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'inbound-duplicate@example.com',
        dmarc: 'pass',
      }),
    );
    expect(second.status).toBe(200);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 10 });
    const dupRows = rows.filter((r) => r.requester_address === 'inbound-duplicate@example.com');
    expect(dupRows).toHaveLength(2); // both genuine requests got their own queued row
    expect(dupRows.every((r) => r.outcome === 'queued')).toBe(true);
  });
});
