import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { signInAsNewTenant } from '../setup/http.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';
import { tenants } from '../../src/db/repositories/tenants.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';

const MB = 1024 * 1024;

/** A Readable that emits `sizeBytes` of zero bytes without ever holding the whole thing in
 * memory at once — a "sparse file" stand-in cheap enough to run at 19-21 MB in a unit
 * test. */
function sparseStream(sizeBytes: number): Readable {
  const CHUNK = 1 * MB;
  let remaining = sizeBytes;
  return new Readable({
    read() {
      if (remaining <= 0) {
        this.push(null);
        return;
      }
      const n = Math.min(CHUNK, remaining);
      remaining -= n;
      this.push(Buffer.alloc(n));
    },
  });
}

describe.skipIf(!hasTestDatabase())('delivery mechanism (AC-R4)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('19 MB (<= ATTACH_LIMIT_BYTES=20MB default): delivered as an attachment', async () => {
    const container = buildTestContainer();
    const { tenantId } = await signInAsNewTenant(container, 'small@example.com');
    const created = await container.services.files.createStaged({
      tenantId,
      stream: sparseStream(19 * MB),
      originalName: 'nineteen.bin',
      mime: 'application/octet-stream',
    });
    await runPendingJobs(container);
    const file = (await files.findById(container.pool, tenantId, created.id))!;
    expect(Number(file.size_bytes)).toBe(19 * MB);
    const tenant = (await tenants.findById(container.pool, tenantId))!;

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'req19@example.com',
      dmarc: 'pass',
    });
    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(200);
    await runPendingJobs(container);

    const rows = await deliveries.listForFile(container.pool, tenantId, file.id);
    expect(rows[0]?.outcome).toBe('sent');
    expect(rows[0]?.mechanism).toBe('attachment');

    const sent = container.fakes.outboundMail.sent.at(-1);
    expect(sent?.attachment?.size).toBe(19 * MB);
    expect(container.fakes.driveShare.fileCount).toBe(1); // only the file.publish seq-0 upload
  });

  it('21 MB (> ATTACH_LIMIT_BYTES=20MB default): delivered via SharingEngine drive_share', async () => {
    const container = buildTestContainer();
    const { tenantId } = await signInAsNewTenant(container, 'big@example.com');
    const created = await container.services.files.createStaged({
      tenantId,
      stream: sparseStream(21 * MB),
      originalName: 'twentyone.bin',
      mime: 'application/octet-stream',
    });
    await runPendingJobs(container);
    const file = (await files.findById(container.pool, tenantId, created.id))!;
    expect(Number(file.size_bytes)).toBe(21 * MB);
    const tenant = (await tenants.findById(container.pool, tenantId))!;

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'req21@example.com',
      dmarc: 'pass',
    });
    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(200);
    await runPendingJobs(container);

    const rows = await deliveries.listForFile(container.pool, tenantId, file.id);
    expect(rows[0]?.outcome).toBe('sent');
    expect(rows[0]?.mechanism).toBe('drive_share');

    const sent = container.fakes.outboundMail.sent.at(-1);
    expect(sent?.attachment).toBeUndefined();
    expect(sent?.text).toContain('drive.google.com');
  });

  it('a purged staged blob (still <= ATTACH_LIMIT_BYTES) falls back to drive_share', async () => {
    const container = buildTestContainer();
    const { tenantId } = await signInAsNewTenant(container, 'purged@example.com');
    const created = await container.services.files.createStaged({
      tenantId,
      stream: sparseStream(1 * MB),
      originalName: 'small-but-purged.bin',
      mime: 'application/octet-stream',
    });
    await runPendingJobs(container);
    const file = (await files.findById(container.pool, tenantId, created.id))!;
    // Simulate the blob already having been purged (e.g. staging.purge ran early).
    await container.ports.blobStaging.remove(file.staging_blob_id!);

    const tenant = (await tenants.findById(container.pool, tenantId))!;
    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'reqpurged@example.com',
      dmarc: 'pass',
    });
    await container.services.requestPipeline.handleWebhook(payload);
    await runPendingJobs(container);

    const rows = await deliveries.listForFile(container.pool, tenantId, file.id);
    expect(rows[0]?.outcome).toBe('sent');
    expect(rows[0]?.mechanism).toBe('drive_share');
  });
});
