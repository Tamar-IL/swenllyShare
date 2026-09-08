import { describe, expect, it, beforeEach } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import type { BlobStagingPort } from '../../src/ports/blob-staging.js';

/**
 * CODE REVIEW — verifying a suspected bug in `handleDeliveryFulfill`
 * (src/jobs/handlers/delivery-fulfill.ts).
 *
 * The handler moves `deliveries.outcome` 'queued' -> 'sending' (markSending) BEFORE the
 * external send call, then treats a job retry that finds outcome==='sending' as "the
 * provider probably accepted it, finalize as sent, never resend" (F-6, RT-13's exact
 * scenario: the outbound send genuinely happened and only the ack was lost).
 *
 * But nothing reverts 'sending' back to 'queued' when the handler throws for a reason
 * that has NOTHING to do with the external send — e.g. a local error reading the staged
 * blob, which happens strictly *after* markSending and *before* outboundMail.send is ever
 * called. This test forces exactly that: blobStaging.open() throws once, after
 * markSending has already flipped the row to 'sending'. No mail is ever sent. On the next
 * job attempt, the handler should retry the ACTUAL send — instead (if the bug is real) it
 * will see outcome === 'sending' and silently finalize the delivery as 'sent' without ever
 * calling the outbound port.
 */
describe.skipIf(!hasTestDatabase())('REVIEW: delivery.fulfill sending-state crash recovery', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it.fails(
    'a crash between markSending and the actual send must not be finalized as sent',
    async () => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(container, 'crash@example.com');

      const outcome = await container.services.requestPipeline.handleWebhook(
        buildSignedWebhookPayload(container, {
          requestToken: file.request_token,
          tenantSlug: tenant.slug,
          fromAddress: 'requester@relay.test',
          dmarc: 'pass',
        }),
      );
      expect(outcome.deliveryId).toBeDefined();

      const sentBefore = container.fakes.outboundMail.sent.length;

      // Local failure AFTER markSending, BEFORE any external send is attempted.
      let failNextOpen = true;
      const real = container.ports.blobStaging;
      const flaky: BlobStagingPort = {
        ...real,
        async open(id: string) {
          if (failNextOpen) {
            failNextOpen = false;
            throw new Error('disk error reading staged blob (simulated crash)');
          }
          return real.open(id);
        },
      };
      (container.ports as { blobStaging: BlobStagingPort }).blobStaging = flaky;

      // First attempt: markSending flips the row, then open() throws -> job fails, no mail sent.
      await runPendingJobs(container);
      expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);

      const afterFirstAttempt = await deliveries.listForFile(container.pool, tenant.id, file.id);
      // The row is stuck 'sending' after a failure that never reached the outbound call.
      expect(afterFirstAttempt[0]?.outcome).toBe('sending');

      // Let the retry become due, and let it run with the SAME flaky port still installed
      // (failNextOpen is now false, so a real retry-and-send attempt would succeed and
      // actually mail the file — the correct at-most-once outcome).
      await testPool().query(`UPDATE jobs SET run_after = now() WHERE kind = 'delivery.fulfill'`);
      await runPendingJobs(container);

      const afterSecondAttempt = await deliveries.listForFile(container.pool, tenant.id, file.id);
      expect(afterSecondAttempt[0]?.outcome).toBe('sent');
      // The bug: this asserts the file was ACTUALLY mailed by the second attempt, not
      // just finalized as 'sent' from the 'sending' short-circuit without ever sending.
      expect(container.fakes.outboundMail.sent.length - sentBefore).toBe(1);
    },
  );
});
