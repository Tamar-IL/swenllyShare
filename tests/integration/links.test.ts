import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { signInAsNewTenant } from '../setup/http.js';
import { buildApp } from '../../src/app.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';
import { Readable } from 'node:stream';

/** Publishes a file through the real domain service (bypassing HTTP) so these tests focus
 * purely on link resolution, not the upload transport already covered by upload-flow. */
async function createReadyFile(
  container: ReturnType<typeof buildTestContainer>,
  tenantId: string,
): Promise<Awaited<ReturnType<typeof files.findById>>> {
  const row = await container.services.files.createStaged({
    tenantId,
    stream: Readable.from(Buffer.from('content')),
    originalName: 'doc.pdf',
    mime: 'application/pdf',
  });
  await runPendingJobs(container);
  return files.findById(container.pool, tenantId, row.id);
}

describe.skipIf(!hasTestDatabase())('links (AC-U2 / AC-U3)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('AC-U2: flag off -> distributionUrl is the raw Zoho public link', async () => {
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: false });
    const { tenantId } = await signInAsNewTenant(container, 'flagoff@example.com');
    const file = (await createReadyFile(container, tenantId))!;

    const url = container.services.links.distributionUrl(file);
    expect(url).toBe(file.zoho_public_link);
    expect(url).toMatch(/^https:\/\/workdrive\.zohoexternal\.com\//);
  });

  it('AC-U3: flag on -> distributionUrl is the branded /s/:slug page, and the branded page never leaks the Zoho URL', async () => {
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: true });
    const app = await buildApp({ container });
    const { tenantId } = await signInAsNewTenant(container, 'flagon@example.com');
    const file = (await createReadyFile(container, tenantId))!;

    const url = container.services.links.distributionUrl(file);
    expect(url).toBe(`${container.config.PUBLIC_BASE_URL}/s/${file.public_slug}`);

    const res = await app.inject({ method: 'GET', url: `/s/${file.public_slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Swenlly');
    expect(res.body).toContain('workdrive.zohoexternal.com/embed/');

    // The raw Zoho public link/resource id must appear in NEITHER the body NOR any header.
    expect(res.body).not.toContain(file.zoho_public_link!);
    expect(res.body).not.toContain(file.zoho_resource_id!);
    const headerBlob = JSON.stringify(res.headers);
    expect(headerBlob).not.toContain(file.zoho_public_link!);
    expect(headerBlob).not.toContain(file.zoho_resource_id!);

    // Download is proxied (never a redirect that would put the Zoho URL in the browser).
    const downloadRes = await app.inject({ method: 'GET', url: `/s/${file.public_slug}/download` });
    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.headers['content-disposition']).toContain('attachment');
    expect(downloadRes.body).toBe('content');
    expect(downloadRes.headers.location).toBeUndefined();
    const downloadHeaderBlob = JSON.stringify(downloadRes.headers);
    expect(downloadHeaderBlob).not.toContain(file.zoho_public_link!);
  });

  it('flag off -> /s/:slug and /s/:slug/download both 404, even for a real slug', async () => {
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: false });
    const app = await buildApp({ container });
    const { tenantId } = await signInAsNewTenant(container, 'flagoffslug@example.com');
    const file = (await createReadyFile(container, tenantId))!;

    const pageRes = await app.inject({ method: 'GET', url: `/s/${file.public_slug}` });
    expect(pageRes.statusCode).toBe(404);

    const downloadRes = await app.inject({ method: 'GET', url: `/s/${file.public_slug}/download` });
    expect(downloadRes.statusCode).toBe(404);
  });
});
