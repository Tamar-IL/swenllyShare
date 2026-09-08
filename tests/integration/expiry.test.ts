import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { signInAsNewTenant } from '../setup/http.js';
import { buildApp } from '../../src/app.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';
import { jobs } from '../../src/db/repositories/jobs.js';
import { tenants } from '../../src/db/repositories/tenants.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDatabase())('expiry (AC-U4)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('virtual-clock advance past expires_at -> branded page shows expired, download 410, and file.expire revokes the link + drive permission', async () => {
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: true, DEFAULT_EXPIRY_DAYS: 1 });
    const app = await buildApp({ container });
    const { tenantId } = await signInAsNewTenant(container, 'expiring@example.com');

    const created = await container.services.files.createStaged({
      tenantId,
      stream: Readable.from(Buffer.from('bytes')),
      originalName: 'expiring.pdf',
      mime: 'application/pdf',
    });
    await runPendingJobs(container);
    const file = (await files.findById(container.pool, tenantId, created.id))!;
    expect(file.status).toBe('ready');
    expect(file.expires_at).not.toBeNull();

    // Share it once so there is a live Drive permission to assert gets revoked.
    const shareResult = await container.services.sharingEngine.share(
      tenantId,
      file.id,
      'req@example.com',
    );
    if (shareResult.type !== 'shared') throw new Error('expected an immediate share');
    expect(container.fakes.driveShare.permissionCount(shareResult.driveFileId)).toBe(1);

    // Advance virtual time past expires_at (belt) and enqueue+run the expire job (braces).
    container.fakes.clock.advance(2 * DAY_MS);

    const pageRes = await app.inject({ method: 'GET', url: `/s/${file.public_slug}` });
    expect(pageRes.statusCode).toBe(200);
    expect(pageRes.body).toContain('אינו זמין');

    const downloadRes = await app.inject({ method: 'GET', url: `/s/${file.public_slug}/download` });
    expect(downloadRes.statusCode).toBe(410);

    await jobs.enqueue(container.pool, {
      kind: 'file.expire',
      payload: { tenantId, fileId: file.id },
    });
    await runPendingJobs(container);

    const expired = await files.findById(container.pool, tenantId, file.id);
    expect(expired?.status).toBe('expired');
    expect(container.fakes.fileStore.links.get(file.zoho_link_id!)?.revoked).toBe(true);
    expect(container.fakes.driveShare.permissionCount(shareResult.driveFileId)).toBe(0);
  });

  it('the inbound pipeline rejects a request against an already-expired file (gate 9)', async () => {
    const container = buildTestContainer();
    const { tenantId } = await signInAsNewTenant(container, 'expiredreq@example.com');

    const created = await container.services.files.createStaged({
      tenantId,
      stream: Readable.from(Buffer.from('bytes')),
      originalName: 'oldfile.pdf',
      mime: 'application/pdf',
    });
    await runPendingJobs(container);

    // Force expiry directly for a crisp, minimal test of gate 9 alone.
    await files.setPublishStep(container.pool, tenantId, created.id, { status: 'expired' });
    const file = (await files.findById(container.pool, tenantId, created.id))!;

    const tenant = (await tenants.findById(container.pool, tenantId))!;
    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'requester@example.com',
      dmarc: 'pass',
    });

    const sentBefore = container.fakes.outboundMail.sent.length;
    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(200);
    // No new send — only the earlier sign-in magic-link email (unrelated) may already be
    // recorded.
    expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);

    const rows = await deliveries.listForFile(container.pool, tenantId, file.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('expired');
  });
});
