import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';

describe.skipIf(!hasTestDatabase())('isolation (AC-A1)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('a delivery grants exactly one permission on one file — never a folder or account-wide grant', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'isolated@example.com', {
      content: 'x'.repeat(30 * 1024 * 1024), // force the drive_share mechanism, not attachment
    });

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'requester@example.com',
      dmarc: 'pass',
    });
    await container.services.requestPipeline.handleWebhook(payload);
    await runPendingJobs(container);

    // The fake never exposes a "grant folder access" or "grant account access" method at
    // all — the port contract itself (architecture.md §2) only allows per-file
    // permissions (`sharePermission(driveFileId, email)`), so isolation is structural.
    // What we CAN assert here: exactly one Drive file ended up with exactly one granted
    // permission, and every other file this tenant owns has zero.
    let filesWithPermissions = 0;
    let totalPermissions = 0;
    for (let i = 1; i <= container.fakes.driveShare.fileCount; i++) {
      const count = container.fakes.driveShare.permissionCount(`drive-file-${i}`);
      totalPermissions += count;
      if (count > 0) filesWithPermissions += 1;
    }
    expect(filesWithPermissions).toBe(1);
    expect(totalPermissions).toBe(1);
  });

  it('two files for the same tenant get independent Zoho resources/links — no shared link between files', async () => {
    const container = buildTestContainer();
    const a = await createTenantWithReadyFile(container, 'sametenant@example.com', {
      originalName: 'a.pdf',
    });
    const created = await container.services.files.createStaged({
      tenantId: a.tenant.id,
      stream: Readable.from(Buffer.from('b')),
      originalName: 'b.pdf',
      mime: 'application/pdf',
    });
    await runPendingJobs(container);
    const b = (await files.findById(container.pool, a.tenant.id, created.id))!;

    expect(a.file.zoho_resource_id).not.toBe(b.zoho_resource_id);
    expect(a.file.zoho_link_id).not.toBe(b.zoho_link_id);
    expect(a.file.request_token).not.toBe(b.request_token);
    expect(a.file.public_slug).not.toBe(b.public_slug);
  });
});
