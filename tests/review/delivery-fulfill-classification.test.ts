import { Readable } from 'node:stream';
import { describe, expect, it, beforeEach } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { signInAsNewTenant } from '../setup/http.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { runPendingJobs, JOB_KINDS } from '../../src/jobs/queue.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { files } from '../../src/db/repositories/files.js';
import { tenants } from '../../src/db/repositories/tenants.js';
import { AmbiguousSendError, PermanentError, TransientError } from '../../src/ports/errors.js';
import type { OutboundMailPort } from '../../src/ports/outbound-mail.js';

/**
 * CRITIC finding F-A (`docs/reviews/critic-report.md`, fixed fix pass 5): a completed
 * outbound exchange that is not 2xx is a *definite* non-send — the requester provably did
 * not receive the file — and must revert `dispatching` back to `sending` so the job's own
 * retry/backoff/dead-letter policy actually applies, never silently finalize `sent`. Only
 * a genuinely ambiguous failure (`AmbiguousSendError`, or an error shape this handler
 * cannot classify) may finalize without resending, and that outcome is now honestly
 * `unconfirmed`, never `sent`.
 *
 * This is the critic's own re-check protocol, item 1: "does the outbound failure
 * classification distinguish definite from ambiguous, or just move the guess."
 */
describe.skipIf(!hasTestDatabase())(
  'REVIEW F-A: delivery.fulfill outbound failure classification',
  () => {
    beforeEach(async () => {
      await truncateAll();
    });

    async function queueOneDelivery(
      container: ReturnType<typeof buildTestContainer>,
      email: string,
    ) {
      const { tenant, file } = await createTenantWithReadyFile(container, email);
      const outcome = await container.services.requestPipeline.handleWebhook(
        buildSignedWebhookPayload(container, {
          requestToken: file.request_token,
          tenantSlug: tenant.slug,
          fromAddress: 'requester@relay.test',
          dmarc: 'pass',
        }),
      );
      expect(outcome.deliveryId).toBeDefined();
      return { tenant, file };
    }

    it('a TransientError from a completed exchange reverts and retries — sent, exactly one mail', async () => {
      const container = buildTestContainer();
      const { tenant, file } = await queueOneDelivery(container, 'transient@example.com');
      const recorder = container.fakes.outboundMail;
      const sentBefore = recorder.sent.length;

      let failNextSend = true;
      const flaky: OutboundMailPort = {
        async send(message) {
          if (failNextSend) {
            failNextSend = false;
            throw new TransientError('Mailgun messages API: HTTP 500');
          }
          return recorder.send(message);
        },
      };
      (container.ports as { outboundMail: OutboundMailPort }).outboundMail = flaky;

      await runPendingJobs(container);
      // First attempt: TransientError -> reverted to `sending`, job backed off. Force the
      // retry due immediately (same technique as tests/redteam/delivery-toctou.test.ts).
      const midway = await deliveries.listForFile(container.pool, tenant.id, file.id);
      expect(midway[0]?.outcome).toBe('sending');
      expect(recorder.sent).toHaveLength(sentBefore); // not sent yet

      await testPool().query(`UPDATE jobs SET run_after = now() WHERE kind = 'delivery.fulfill'`);
      await runPendingJobs(container);

      const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
      expect(rows[0]?.outcome).toBe('sent');
      expect(recorder.sent.length - sentBefore).toBe(1);
    });

    it('a PermanentError from a completed exchange dead-letters — failed, zero mails ever sent', async () => {
      const container = buildTestContainer({ JOB_MAX_ATTEMPTS: 2 });
      const { tenant, file } = await queueOneDelivery(container, 'permanent@example.com');
      const recorder = container.fakes.outboundMail;
      const sentBefore = recorder.sent.length;

      const alwaysFails: OutboundMailPort = {
        async send() {
          throw new PermanentError('Mailgun messages API: HTTP 401');
        },
      };
      (container.ports as { outboundMail: OutboundMailPort }).outboundMail = alwaysFails;

      for (let i = 0; i < container.config.JOB_MAX_ATTEMPTS + 1; i++) {
        await testPool().query(`UPDATE jobs SET run_after = now() WHERE kind = 'delivery.fulfill'`);
        await runPendingJobs(container, { kinds: JOB_KINDS });
      }

      const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
      expect(rows[0]?.outcome).toBe('failed');
      expect(recorder.sent).toHaveLength(sentBefore); // never actually sent
    });

    it('an AmbiguousSendError finalizes `unconfirmed` — never `sent`, never blindly retried', async () => {
      const container = buildTestContainer();
      const { tenant, file } = await queueOneDelivery(container, 'ambiguous@example.com');
      const recorder = container.fakes.outboundMail;
      const sentBefore = recorder.sent.length;

      const ambiguous: OutboundMailPort = {
        async send() {
          throw new AmbiguousSendError('no response — request may or may not have arrived');
        },
      };
      (container.ports as { outboundMail: OutboundMailPort }).outboundMail = ambiguous;

      await runPendingJobs(container);
      // No further pending delivery.fulfill job — it finalized on the first attempt.
      const { rows: pendingJobs } = await testPool().query(
        `SELECT count(*)::int AS n FROM jobs WHERE kind = 'delivery.fulfill' AND status = 'pending'`,
      );
      expect(pendingJobs[0].n).toBe(0);

      const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
      expect(rows[0]?.outcome).toBe('unconfirmed');
      expect(recorder.sent).toHaveLength(sentBefore);
    });

    describe('Drive-share branch: grant and reply are independently retryable', () => {
      async function queueDriveShareDelivery(
        container: ReturnType<typeof buildTestContainer>,
        email: string,
      ) {
        const { tenantId } = await signInAsNewTenant(container, email);
        const created = await container.services.files.createStaged({
          tenantId,
          stream: Readable.from(Buffer.from('drive share payload')),
          originalName: 'big.bin',
          mime: 'application/octet-stream',
        });
        await runPendingJobs(container);
        const file = (await files.findById(container.pool, tenantId, created.id))!;
        // Force the drive_share branch cheaply — remove the staged blob so the
        // attachment path's "still staged" check fails (same trick as
        // tests/integration/delivery-mechanism.test.ts).
        await container.ports.blobStaging.remove(file.staging_blob_id!);
        const tenant = (await tenants.findById(container.pool, tenantId))!;

        const outcome = await container.services.requestPipeline.handleWebhook(
          buildSignedWebhookPayload(container, {
            requestToken: file.request_token,
            tenantSlug: tenant.slug,
            fromAddress: 'requester@relay.test',
            dmarc: 'pass',
          }),
        );
        expect(outcome.deliveryId).toBeDefined();
        return { tenant, file };
      }

      it('grant succeeds, reply throws TransientError once -> exactly one grant, one mail after retry', async () => {
        const container = buildTestContainer();
        const { tenant, file } = await queueDriveShareDelivery(container, 'drivegrant@example.com');
        const recorder = container.fakes.outboundMail;
        const sentBefore = recorder.sent.length;

        let failNextSend = true;
        const flaky: OutboundMailPort = {
          async send(message) {
            if (failNextSend) {
              failNextSend = false;
              throw new TransientError('Mailgun messages API: HTTP 500');
            }
            return recorder.send(message);
          },
        };
        (container.ports as { outboundMail: OutboundMailPort }).outboundMail = flaky;

        await runPendingJobs(container);
        const midway = await deliveries.listForFile(container.pool, tenant.id, file.id);
        expect(midway[0]?.outcome).toBe('granted');
        expect(midway[0]?.drive_copy_id).toBeTruthy();

        await testPool().query(`UPDATE jobs SET run_after = now() WHERE kind = 'delivery.fulfill'`);
        await runPendingJobs(container);

        const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
        expect(rows[0]?.outcome).toBe('sent');
        expect(rows[0]?.mechanism).toBe('drive_share');
        // The reply was actually mailed exactly once...
        expect(recorder.sent.length - sentBefore).toBe(1);
        // ...and the permission grant was never redundantly repeated for the retry — the
        // `SharingEngine` reservation (`drive_copies.share_count`, bumped once per `share()`
        // call) stayed at exactly 1, proving the reply-only retry never re-called `share()`.
        const { rows: copyRows } = await testPool().query<{ share_count: number }>(
          `SELECT share_count FROM drive_copies WHERE id = $1`,
          [rows[0]?.drive_copy_id],
        );
        expect(copyRows[0]?.share_count).toBe(1);
      });
    });
  },
);
