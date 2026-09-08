import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { files } from '../../src/db/repositories/files.js';
import type { OutboundMailPort } from '../../src/ports/outbound-mail.js';

/**
 * RED TEAM — the window between "the pipeline authorised a delivery" and "the worker
 * actually mails the file".
 *
 * Gates 8–9 (allowlist, expiry) run on the HTTP request; `delivery.fulfill` runs later —
 * after a paced re-share defer (SHARE_PACE_MIN_INTERVAL_MS), after exponential backoff
 * (up to 5 minutes per attempt, JOB_MAX_ATTEMPTS=8 → hours), or after a queue backlog.
 * The handler re-reads the file row but re-checks NOTHING on it. The sender's emergency
 * controls — expire now, delete now, tighten the allowlist — therefore do not stop a
 * request that is already in flight.
 */
describe.skipIf(!hasTestDatabase())('RED TEAM — authorise-then-deliver TOCTOU (AC-U4)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  async function queueOneDelivery(container: ReturnType<typeof buildTestContainer>) {
    const { tenant, file } = await createTenantWithReadyFile(container, 'toctou@example.com');
    const outcome = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'requester@relay.test',
        dmarc: 'pass',
      }),
    );
    expect(outcome.deliveryId).toBeDefined();
    return { tenant, file, deliveryId: outcome.deliveryId! };
  }

  // ---------------------------------------------------------------- RT-10
  it('RT-10: a file that expires between enqueue and fulfilment must not be mailed out', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await queueOneDelivery(container);
    const sentBefore = container.fakes.outboundMail.sent.length;

    // Sender sets a short expiry; virtual time then passes it before the worker runs.
    await files.updateSettings(container.pool, tenant.id, file.id, {
      expiresAt: new Date(container.fakes.clock.now().getTime() + 60_000),
    });
    container.fakes.clock.advance(10 * 60_000);

    await runPendingJobs(container);

    expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);
  });

  // ---------------------------------------------------------------- RT-11
  it('RT-11: a file the sender DELETES between enqueue and fulfilment must not be mailed out', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await queueOneDelivery(container);
    const sentBefore = container.fakes.outboundMail.sent.length;

    // "Take it down now" — the only emergency control the sender has.
    await files.markDeleted(container.pool, tenant.id, file.id);

    await runPendingJobs(container);

    expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).not.toBe('sent');
  });

  // ---------------------------------------------------------------- RT-12
  it('RT-12: tightening the allowlist between enqueue and fulfilment must not be bypassed', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await queueOneDelivery(container);
    const sentBefore = container.fakes.outboundMail.sent.length;

    // Sender realises the requester should never have been served and locks the file
    // down to an allowlist that excludes them.
    await files.updateSettings(container.pool, tenant.id, file.id, {
      allowlistMode: 'allowlist',
    });

    await runPendingJobs(container);

    expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);
  });

  // ---------------------------------------------------------------- RT-13
  // `delivery.fulfill` sends first and records second. Any failure after the provider has
  // accepted the message (socket timeout on the response, pod eviction, a transient DB
  // error on `deliveries.complete`) is genuinely ambiguous — nobody, including this
  // process, can tell whether the requester actually received the file. The webhook
  // replay gate exists precisely because "replay is re-disclosure" (architecture.md
  // §4.2); a retry here would risk exactly that, so fix pass 5 (F-A,
  // `docs/reviews/critic-report.md`) makes the handler do neither: it never blindly
  // resends AND it never claims `sent` when it does not actually know. The outcome is
  // recorded honestly as `unconfirmed` — see `tests/review/delivery-fulfill-classification.test.ts`
  // for the *classified* failures (a definite Mailgun non-send) that DO safely retry.
  it('RT-13: a `delivery.fulfill` retry must neither re-send the file nor claim `sent` for an ambiguous failure', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await queueOneDelivery(container);
    const recorder = container.fakes.outboundMail;
    const sentBefore = recorder.sent.length;

    // The provider accepted the message; we never saw the ack — an unclassified failure
    // (not one of the typed PortErrors), which fix pass 5 treats as ambiguous rather than
    // guessing either "definitely sent" or "definitely not sent".
    let failNextSend = true;
    const flaky: OutboundMailPort = {
      async send(message) {
        const result = await recorder.send(message);
        if (failNextSend) {
          failNextSend = false;
          throw new Error('socket hang up after the provider accepted the message');
        }
        return result;
      },
    };
    (container.ports as { outboundMail: OutboundMailPort }).outboundMail = flaky;

    await runPendingJobs(container);
    // The queue backs the job off; a real worker picks it up on the next tick. Since the
    // ambiguous failure already finalized the delivery on the first attempt, this second
    // drain is a no-op (there is no `delivery.fulfill` job left pending for it).
    await testPool().query(`UPDATE jobs SET run_after = now() WHERE kind = 'delivery.fulfill'`);
    await runPendingJobs(container);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('unconfirmed');
    // The provider call happened exactly once — never blindly retried while ambiguous.
    expect(recorder.sent.length - sentBefore).toBe(1);
  });

  // ---------------------------------------------------------------- blocked
  it('BLOCKED: a file already expired at request time never enqueues a delivery', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'toctou-ok@example.com');
    await files.updateSettings(container.pool, tenant.id, file.id, {
      expiresAt: new Date(container.fakes.clock.now().getTime() - 1000),
    });
    const sentBefore = container.fakes.outboundMail.sent.length;

    const outcome = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'requester@relay.test',
        dmarc: 'pass',
      }),
    );
    expect(outcome.deliveryId).toBeUndefined();
    await runPendingJobs(container);
    expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('expired');
  });

  it('BLOCKED: a deleted file never enqueues a delivery at request time', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'toctou-del@example.com');
    await files.markDeleted(container.pool, tenant.id, file.id);

    const outcome = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'requester@relay.test',
        dmarc: 'pass',
      }),
    );
    expect(outcome.deliveryId).toBeUndefined();
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.reason).toBe('file_status_deleted');
  });
});
