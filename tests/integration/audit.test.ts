import { sign as signCookie } from '@fastify/cookie';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { CookieJar } from '../setup/http.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { buildApp } from '../../src/app.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';

describe.skipIf(!hasTestDatabase())('audit (AC-A2)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('every terminal pipeline outcome (sent, quarantined, rate_limited, expired) writes a queryable row', async () => {
    const container = buildTestContainer({ RATE_REQUESTER_PER_HOUR: 1 });
    const { tenant, file } = await createTenantWithReadyFile(container, 'audited@example.com');

    // sent
    await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'sent-req@example.com',
        dmarc: 'pass',
      }),
    );
    await runPendingJobs(container);

    // quarantined
    await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'quarantined-req@example.com',
        dmarc: 'fail',
      }),
    );

    // rate_limited: RATE_REQUESTER_PER_HOUR=1, so a second request from sent-req@ trips it
    await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'sent-req@example.com',
        dmarc: 'pass',
      }),
    );

    // expired
    await files.setPublishStep(container.pool, tenant.id, file.id, { status: 'expired' });
    await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'expired-req@example.com',
        dmarc: 'pass',
      }),
    );

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    const outcomes = new Set(rows.map((d) => d.outcome));
    expect(outcomes.has('sent')).toBe(true);
    expect(outcomes.has('quarantined')).toBe(true);
    expect(outcomes.has('rate_limited')).toBe(true);
    expect(outcomes.has('expired')).toBe(true);
  });

  it('GET /api/files/:id/deliveries returns mechanism, outcome, address, and a well-formed timestamp', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'apiaudit@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'apireq@example.com',
      dmarc: 'pass',
    });
    await container.services.requestPipeline.handleWebhook(payload);
    await runPendingJobs(container);

    const session = await container.services.auth.createSession(tenant.id);
    const jar = new CookieJar();
    jar.set('swy_sess', signCookie(session.id, container.config.SESSION_SECRET));

    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${file.id}/deliveries`,
      headers: { cookie: jar.header() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ address: string; mechanism: string; outcome: string; at: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ address: 'apireq@example.com', outcome: 'sent' });
    expect(body.items[0]?.mechanism).toBe('attachment');
    expect(Number.isNaN(new Date(body.items[0]!.at).getTime())).toBe(false);
  });

  it('GET /api/files/:id/deliveries returns resendable + resendPath, true only for failed/unconfirmed outcomes', async () => {
    // Fix pass 8 (code-review.md polish-pass finding 3): a delivery that transitions to
    // failed/unconfirmed AFTER the sender already has the page open only gets a resend
    // button once this endpoint carries the same resendability signal the SSR row does.
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'resendflag@example.com');

    const failedDelivery = await deliveries.insertTerminal(container.pool, {
      tenantId: tenant.id,
      fileId: file.id,
      requesterAddress: 'failed-req@example.com',
      outcome: 'failed',
      dmarc: 'pass',
    });
    // `insertTerminal` deliberately excludes 'sent' (that outcome only ever comes from
    // `complete()`, the real fulfillment path) — seeded directly via SQL instead, same
    // as `tests/e2e/smoke.e2e.ts` does for its own seeded-delivery assertion.
    await container.pool.query(
      `INSERT INTO deliveries (tenant_id, file_id, requester_address, mechanism, outcome)
         VALUES ($1, $2, 'sent-req@example.com', 'attachment', 'sent')`,
      [tenant.id, file.id],
    );

    const session = await container.services.auth.createSession(tenant.id);
    const jar = new CookieJar();
    jar.set('swy_sess', signCookie(session.id, container.config.SESSION_SECRET));

    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${file.id}/deliveries`,
      headers: { cookie: jar.header() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        id: string;
        outcome: string;
        resendable: boolean;
        resendPath: string;
      }>;
    };

    const failedItem = body.items.find((i) => i.id === failedDelivery.id);
    expect(failedItem?.resendable).toBe(true);
    expect(failedItem?.resendPath).toBe(`/files/${file.id}/deliveries/${failedDelivery.id}/resend`);

    const sentItem = body.items.find((i) => i.outcome === 'sent');
    expect(sentItem?.resendable).toBe(false);
  });
});
