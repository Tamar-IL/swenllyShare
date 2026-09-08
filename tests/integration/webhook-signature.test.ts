import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { buildApp } from '../../src/app.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';

describe.skipIf(!hasTestDatabase())('webhook signature verification (AC-R6)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('a bad signature -> 401, no side effects', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'badsig@example.com');
    const sentBefore = container.fakes.outboundMail.sent.length;

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'req@example.com',
      dmarc: 'pass',
      signatureOverride: 'deadbeef'.repeat(8),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/mailgun/inbound',
      payload: new URLSearchParams(payload as Record<string, string>).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(401);
    expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);
    expect(await deliveries.listForFile(container.pool, tenant.id, file.id)).toHaveLength(0);
  });

  it('an absent signature -> 401, no side effects', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'nosig@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'req@example.com',
      dmarc: 'pass',
    });
    delete payload.signature;

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/mailgun/inbound',
      payload: new URLSearchParams(payload as Record<string, string>).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(401);
    expect(await deliveries.listForFile(container.pool, tenant.id, file.id)).toHaveLength(0);
  });

  it('an expired timestamp (outside the ±5 minute window) -> 401', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'expiredsig@example.com');

    const nowSeconds = Math.floor(container.ports.clock.now().getTime() / 1000);
    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'req@example.com',
      dmarc: 'pass',
      timestampSecondsOverride: nowSeconds - 10 * 60, // 10 minutes ago
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/mailgun/inbound',
      payload: new URLSearchParams(payload as Record<string, string>).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('a replayed (already-seen) signature -> 200 with no new send and no duplicate audit row', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'replay@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'req@example.com',
      dmarc: 'pass',
    });
    const body = new URLSearchParams(payload as Record<string, string>).toString();

    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/mailgun/inbound',
      payload: body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(first.statusCode).toBe(200);

    const afterFirst = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(afterFirst).toHaveLength(1);

    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/mailgun/inbound',
      payload: body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(second.statusCode).toBe(200);

    const afterSecond = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(afterSecond).toHaveLength(1); // no new row from the replay
  });

  it('a valid signature reaches the pipeline and queues a delivery', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'goodsig@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'req@example.com',
      dmarc: 'pass',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/mailgun/inbound',
      payload: new URLSearchParams(payload as Record<string, string>).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('queued');
  });
});
