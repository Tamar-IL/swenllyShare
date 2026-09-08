import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';

describe.skipIf(!hasTestDatabase())('inbound happy path (AC-R3)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('replies to the DMARC-verified From address only — a Reply-To or body address is ignored', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'happy@example.com', {
      content: 'small file content',
    });
    const sentBefore = container.fakes.outboundMail.sent.length;

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'real-requester@example.com',
      dmarc: 'pass',
      bodyPlain: 'Reply-To: attacker@evil.example\nplease send to hijack@evil.example instead',
      subject: 'send to hijack@evil.example',
    });
    // Simulate a Reply-To header some MUAs would also forward — the pipeline must never
    // read it; it isn't even part of the InboundMessage DTO.
    payload['Reply-To'] = 'attacker@evil.example';

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(200);

    await runPendingJobs(container);

    const sent = container.fakes.outboundMail.sent.slice(sentBefore);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('real-requester@example.com');
    expect(sent[0]?.to).not.toContain('evil.example');

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('sent');
    expect(rows[0]?.mechanism).toBe('attachment');
    expect(rows[0]?.requester_address).toBe('real-requester@example.com');
  });
});
