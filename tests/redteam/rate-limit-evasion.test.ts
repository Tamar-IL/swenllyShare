import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';

/**
 * RED TEAM — the rate gates (architecture.md §4.7). The per-requester bucket is keyed on
 * the raw From address string. Every mainstream provider hands the same mailbox an
 * unlimited supply of distinct-but-equivalent address spellings (sub-addressing, and dot
 * insertion at Gmail), and any attacker with a catch-all domain has an unlimited supply
 * outright — so "5 requests per requester per hour" is only as strong as the
 * normalisation applied to the key, which today is none.
 */
describe.skipIf(!hasTestDatabase())('RED TEAM — rate-gate evasion', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  async function fire(
    container: ReturnType<typeof buildTestContainer>,
    tenantSlug: string,
    requestToken: string,
    fromAddress: string,
  ) {
    return container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken,
        tenantSlug,
        fromAddress,
        dmarc: 'pass',
      }),
    );
  }

  // ---------------------------------------------------------------- RT-30
  it('RT-30: sub-addressing (`user+tag@host`) must not multiply the per-requester budget', async () => {
    const container = buildTestContainer({
      RATE_REQUESTER_PER_HOUR: 3,
      RATE_FILE_PER_HOUR: 1000,
      RATE_TENANT_PER_HOUR: 1000,
    });
    const { tenant, file } = await createTenantWithReadyFile(container, 'rl-plus@example.com');

    for (let i = 0; i < 12; i++) {
      await fire(container, tenant.slug, file.request_token, `mallory+${i}@relay.test`);
    }

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, {
      limit: 1000,
    });
    const queued = rows.filter((r) => r.outcome === 'queued');
    // All 12 land in the same real mailbox; the budget is 3.
    expect(queued.length).toBeLessThanOrEqual(3);
  });

  it('RT-30b: Gmail dot-insertion must not multiply the per-requester budget', async () => {
    const container = buildTestContainer({
      RATE_REQUESTER_PER_HOUR: 2,
      RATE_FILE_PER_HOUR: 1000,
      RATE_TENANT_PER_HOUR: 1000,
    });
    const { tenant, file } = await createTenantWithReadyFile(container, 'rl-dots@example.com');

    for (const address of [
      'mallory@gmail.com',
      'm.allory@gmail.com',
      'm.a.llory@gmail.com',
      'm.a.l.lory@gmail.com',
      'mallory+x@gmail.com',
    ]) {
      await fire(container, tenant.slug, file.request_token, address);
    }

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 100 });
    expect(rows.filter((r) => r.outcome === 'queued').length).toBeLessThanOrEqual(2);
  });

  // ---------------------------------------------------------------- RT-31
  // There is no per-requester-DOMAIN bucket. One attacker domain (or one catch-all
  // mailbox) can therefore consume a file's ENTIRE hourly budget with distinct addresses,
  // and every legitimate requester for the rest of the hour is silently refused — the UX
  // brief's "silence is the correct response" turns a nuisance into an invisible outage.
  it("RT-31: one requester domain must not be able to consume a whole file's hourly budget", async () => {
    const container = buildTestContainer({
      RATE_REQUESTER_PER_HOUR: 1000,
      RATE_FILE_PER_HOUR: 6,
      RATE_TENANT_PER_HOUR: 1000,
    });
    const { tenant, file } = await createTenantWithReadyFile(container, 'rl-dos@example.com');

    for (let i = 0; i < 6; i++) {
      await fire(container, tenant.slug, file.request_token, `bot-${i}@attacker.test`);
    }

    // A real recipient, first request of the hour, different domain.
    const legit = await fire(
      container,
      tenant.slug,
      file.request_token,
      'real.person@customer.test',
    );
    expect(legit.deliveryId).toBeDefined();
  });

  // ---------------------------------------------------------------- blocked
  it('BLOCKED: case variants of one address share a single bucket', async () => {
    const container = buildTestContainer({
      RATE_REQUESTER_PER_HOUR: 2,
      RATE_FILE_PER_HOUR: 1000,
      RATE_TENANT_PER_HOUR: 1000,
    });
    const { tenant, file } = await createTenantWithReadyFile(container, 'rl-case@example.com');

    for (const address of [
      'Mallory@Relay.Test',
      'MALLORY@RELAY.TEST',
      'mallory@relay.test',
      'mAlLoRy@relay.test',
    ]) {
      await fire(container, tenant.slug, file.request_token, address);
    }

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 100 });
    expect(rows.filter((r) => r.outcome === 'queued')).toHaveLength(2);
    expect(rows.filter((r) => r.outcome === 'rate_limited')).toHaveLength(2);
  });

  it('BLOCKED: concurrent identical requests do not slip past the per-requester gate', async () => {
    const container = buildTestContainer({
      RATE_REQUESTER_PER_HOUR: 2,
      RATE_FILE_PER_HOUR: 1000,
      RATE_TENANT_PER_HOUR: 1000,
    });
    const { tenant, file } = await createTenantWithReadyFile(container, 'rl-race@example.com');

    // 10 distinct signed webhooks (so the replay gate does not absorb them) fired at once.
    const payloads = Array.from({ length: 10 }, () =>
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'racer@relay.test',
        dmarc: 'pass',
      }),
    );
    await Promise.all(payloads.map((p) => container.services.requestPipeline.handleWebhook(p)));

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 100 });
    expect(rows).toHaveLength(10);
    expect(rows.filter((r) => r.outcome === 'queued')).toHaveLength(2);
  });

  it('BLOCKED: the tenant bucket caps a spread-across-files attack', async () => {
    const container = buildTestContainer({
      RATE_REQUESTER_PER_HOUR: 1000,
      RATE_FILE_PER_HOUR: 1000,
      RATE_TENANT_PER_HOUR: 3,
    });
    const { tenant, file } = await createTenantWithReadyFile(container, 'rl-tenant@example.com');

    for (let i = 0; i < 6; i++) {
      await fire(container, tenant.slug, file.request_token, `bot-${i}@attacker.test`);
    }
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 100 });
    expect(rows.filter((r) => r.outcome === 'queued')).toHaveLength(3);
    expect(rows.filter((r) => r.reason?.includes('tenant'))).toHaveLength(3);
  });
});
