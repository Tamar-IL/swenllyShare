import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';
import { driveCopies } from '../../src/db/repositories/drive-copies.js';

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

  /**
   * Fix pass 7 (critic-report.md #6, architecture.md §3/§5): the Zoho adapter used to
   * ignore `tenantFolder` entirely — every upload landed in the one shared
   * `ZOHO_TEAM_FOLDER_ID` regardless of tenant. The Google adapter's `uploadResumable`
   * did not even accept a tenant folder parameter, despite its own doc comment claiming
   * "into the tenant's folder". Both now resolve (and cache) one folder per tenant.
   */
  it("every upload for one tenant lands under that tenant's OWN folder — in both Zoho and Google Drive — and a different tenant gets a different one", async () => {
    const container = buildTestContainer();
    const a1 = await createTenantWithReadyFile(container, 'folder-tenant-a@example.com', {
      originalName: 'a1.pdf',
    });
    const created = await container.services.files.createStaged({
      tenantId: a1.tenant.id,
      stream: Readable.from(Buffer.from('a2')),
      originalName: 'a2.pdf',
      mime: 'application/pdf',
    });
    await runPendingJobs(container);
    const a2 = (await files.findById(container.pool, a1.tenant.id, created.id))!;

    const b1 = await createTenantWithReadyFile(container, 'folder-tenant-b@example.com', {
      originalName: 'b1.pdf',
    });

    const zohoStore = container.fakes.fileStore;
    const a1ZohoFolder = zohoStore.resources.get(a1.file.zoho_resource_id!)?.folderId;
    const a2ZohoFolder = zohoStore.resources.get(a2.zoho_resource_id!)?.folderId;
    const b1ZohoFolder = zohoStore.resources.get(b1.file.zoho_resource_id!)?.folderId;
    expect(a1ZohoFolder).toBeTruthy();
    expect(a1ZohoFolder).toBe(a2ZohoFolder); // same tenant, same folder
    expect(a1ZohoFolder).not.toBe(b1ZohoFolder); // different tenant, different folder
    // Exactly two distinct tenant folders were ever created, not one per upload (three
    // uploads happened above) — proves the cache, not just the isolation.
    expect(zohoStore.folders.size).toBe(2);

    const driveShare = container.fakes.driveShare;
    // `files.drive_active_copy_id` is the `drive_copies` ROW id, not the Drive file id
    // itself — resolve through the repository to get the actual `drive_file_id`.
    const a1Copy = await driveCopies.getBySeq(container.pool, a1.tenant.id, a1.file.id, 0);
    const a2Copy = await driveCopies.getBySeq(container.pool, a1.tenant.id, a2.id, 0);
    const b1Copy = await driveCopies.getBySeq(container.pool, b1.tenant.id, b1.file.id, 0);
    const a1DriveFolderId = driveShare.folderIdOf(a1Copy!.drive_file_id!);
    const a2DriveFolderId = driveShare.folderIdOf(a2Copy!.drive_file_id!);
    const b1DriveFolderId = driveShare.folderIdOf(b1Copy!.drive_file_id!);
    expect(a1DriveFolderId).toBeTruthy();
    expect(a1DriveFolderId).toBe(a2DriveFolderId);
    expect(a1DriveFolderId).not.toBe(b1DriveFolderId);
    expect(driveShare.folders.size).toBe(2);
  });
});
