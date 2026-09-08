import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { inboundMessages } from '../../src/db/repositories/inbound-messages.js';

/**
 * F-1's `INBOUND_REQUESTS_ENABLED` kill switch (`docs/security/red-team-report.md`):
 * lets the founder hold the whole inbound-email path shut — no deploy needed — until a
 * live Mailgun payload has confirmed the DMARC/SPF/DKIM field-name guess in
 * `src/adapters/mailgun/mapping.ts` (`docs/runbooks/live-spikes.md` spike 3).
 */
describe.skipIf(!hasTestDatabase())('INBOUND_REQUESTS_ENABLED kill switch (F-1)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('false: a signature-verified, otherwise-valid webhook is quarantined, never queued', async () => {
    const container = buildTestContainer({ INBOUND_REQUESTS_ENABLED: false });
    const { tenant, file } = await createTenantWithReadyFile(container, 'killswitch@example.com');
    const sentBefore = container.fakes.outboundMail.sent.length; // signing in already sent one

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'legit@relay.test',
      dmarc: 'pass', // would otherwise sail straight through every gate
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(200);
    expect(outcome.deliveryId).toBeUndefined();
    expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);

    // No deliveries row: there is no tenant/file resolution to attach one to yet (the
    // switch is checked before gate 3), only the inbound_messages row from gate 2.
    expect(await deliveries.listForFile(container.pool, tenant.id, file.id)).toHaveLength(0);
    const inboundRow = await inboundMessages.findBySignatureToken(
      container.pool,
      String(payload.token),
    );
    expect(inboundRow?.quarantined).toBe(true);
    expect(inboundRow?.reason).toBe('inbound_disabled');
  });

  it('false: an invalid signature is still 401 — the switch never weakens gate 1', async () => {
    const container = buildTestContainer({ INBOUND_REQUESTS_ENABLED: false });
    const { tenant, file } = await createTenantWithReadyFile(container, 'killswitch2@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'legit@relay.test',
      dmarc: 'pass',
      signatureOverride: '00'.repeat(32),
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(401);
  });

  it('true (default): the pipeline runs normally', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'killswitch3@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'legit@relay.test',
      dmarc: 'pass',
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.deliveryId).toBeDefined();
  });
});
