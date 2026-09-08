import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { CookieJar, getCsrfToken } from '../setup/http.js';
import { buildApp } from '../../src/app.js';

describe.skipIf(!hasTestDatabase())('rate limits (architecture.md §4.7, §8)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('RATE_REQUESTER_PER_HOUR: the (N+1)th request from the same requester is rate_limited', async () => {
    const container = buildTestContainer({ RATE_REQUESTER_PER_HOUR: 3 });
    const { tenant, file } = await createTenantWithReadyFile(container, 'ratereq@example.com');

    for (let i = 0; i < 3; i++) {
      const outcome = await container.services.requestPipeline.handleWebhook(
        buildSignedWebhookPayload(container, {
          requestToken: file.request_token,
          tenantSlug: tenant.slug,
          fromAddress: 'samereq@example.com',
          dmarc: 'pass',
        }),
      );
      expect(outcome.status).toBe(200);
    }

    await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'samereq@example.com',
        dmarc: 'pass',
      }),
    );

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.outcome).toBe('rate_limited'); // most recent first
  });

  it('RATE_FILE_PER_HOUR: many distinct requesters against one file still trip the per-file limit', async () => {
    const container = buildTestContainer({ RATE_REQUESTER_PER_HOUR: 100, RATE_FILE_PER_HOUR: 2 });
    const { tenant, file } = await createTenantWithReadyFile(container, 'ratefile@example.com');

    for (let i = 0; i < 2; i++) {
      const outcome = await container.services.requestPipeline.handleWebhook(
        buildSignedWebhookPayload(container, {
          requestToken: file.request_token,
          tenantSlug: tenant.slug,
          fromAddress: `distinct-${i}@example.com`,
          dmarc: 'pass',
        }),
      );
      expect(outcome.status).toBe(200);
    }

    await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'distinct-2@example.com',
        dmarc: 'pass',
      }),
    );

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    const rateLimited = rows.filter((r) => r.outcome === 'rate_limited');
    expect(rateLimited).toHaveLength(1);
  });

  it('POST /signin is rate-limited per RATE_MAGICLINK_PER_HOUR', async () => {
    const container = buildTestContainer({ RATE_MAGICLINK_PER_HOUR: 2 });
    const app = await buildApp({ container });
    const jar = new CookieJar();

    for (let i = 0; i < 2; i++) {
      const csrfToken = await getCsrfToken(app, jar);
      const res = await app.inject({
        method: 'POST',
        url: '/signin',
        headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          _csrf: csrfToken,
          email: 'ratelimited@example.com',
        }).toString(),
      });
      expect(res.statusCode).toBe(200);
    }

    const csrfToken = await getCsrfToken(app, jar);
    const res = await app.inject({
      method: 'POST',
      url: '/signin',
      headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrfToken,
        email: 'ratelimited@example.com',
      }).toString(),
    });
    expect(res.statusCode).toBe(429);
  });
});
