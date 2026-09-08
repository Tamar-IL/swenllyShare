import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { inboundMessages } from '../../src/db/repositories/inbound-messages.js';

describe.skipIf(!hasTestDatabase())('inbound DMARC gate (AC-R1)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it.each(['fail', 'none', 'unknown'] as const)(
    'dmarc=%s -> zero outbound sends and a quarantined audit row',
    async (dmarcResult) => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(
        container,
        `dmarc-${dmarcResult}@example.com`,
      );
      const sentBefore = container.fakes.outboundMail.sent.length;

      const payload = buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'attacker@example.com',
        dmarc: dmarcResult,
      });

      const outcome = await container.services.requestPipeline.handleWebhook(payload);
      expect(outcome.status).toBe(200);
      expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);

      const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe('quarantined');
      expect(rows[0]?.reason).toBe(`dmarc_${dmarcResult}`);

      const inboundRow = await inboundMessages.findBySignatureToken(
        container.pool,
        String(payload.token),
      );
      expect(inboundRow?.quarantined).toBe(true);
    },
  );

  it('an absent dmarc field defaults to unknown, never inferred as pass', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'dmarc-absent@example.com');
    const sentBefore = container.fakes.outboundMail.sent.length;

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'someone@example.com',
      // dmarc intentionally omitted
    });
    expect('dmarc' in payload).toBe(false);

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(200);
    expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('quarantined');
    expect(rows[0]?.reason).toBe('dmarc_unknown');
  });

  it('dmarc=pass proceeds past the gate (no quarantine)', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'dmarc-pass@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'legit@example.com',
      dmarc: 'pass',
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(200);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('queued');
  });
});
