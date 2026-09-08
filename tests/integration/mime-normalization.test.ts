import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer, type TestContainer } from '../setup/container.js';
import { signInAsNewTenant, getCsrfToken, CookieJar } from '../setup/http.js';
import { buildMultipartUpload } from '../setup/multipart.js';
import { buildApp } from '../../src/app.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';

/**
 * Finding #4 (docs/security/appsec-review.md): `FilesService.createStaged` normalizes a
 * client-supplied `Content-Type` (via `normalizeMime` — see the pure unit tests in
 * `tests/unit/files-domain.test.ts`) before it is stored, and the public-share download
 * route (`/s/:slug/download`) echoes the *stored* `mime` verbatim as its `Content-Type`
 * response header — so the stored value must already be safe by the time it gets there.
 * This end-to-end pass proves both halves are wired together, not just the pure function.
 */
describe.skipIf(!hasTestDatabase())('MIME normalization at upload', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  async function uploadAndPublish(
    contentType: string,
  ): Promise<{ fileId: string; tenantId: string; container: TestContainer }> {
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: true });
    const app = await buildApp({ container });
    const jar = new CookieJar();
    const { tenantId, cookieHeader } = await signInAsNewTenant(
      container,
      `mime-${Date.now()}@example.com`,
    );
    jar.set('swy_sess', cookieHeader.split('=')[1]!);
    const csrfToken = await getCsrfToken(app, jar, '/files/new');
    const { body, contentType: multipartContentType } = buildMultipartUpload({
      fieldName: 'file',
      filename: 'doc.bin',
      content: Buffer.from('hello'),
      contentType,
    });
    const uploadRes = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        cookie: jar.header(),
        'content-type': multipartContentType,
        'x-csrf-token': csrfToken,
      },
      payload: body,
    });
    expect(uploadRes.statusCode).toBe(201);
    const { fileId } = uploadRes.json() as { fileId: string };
    await runPendingJobs(container);
    return { fileId, tenantId, container };
  }

  it('lowercases and strips parameters off a client-supplied Content-Type before storing it', async () => {
    const { fileId, tenantId, container } = await uploadAndPublish(
      'Application/PDF; charset=binary',
    );
    const row = await files.findById(container.pool, tenantId, fileId);
    expect(row?.mime).toBe('application/pdf');
  });

  it('falls back to application/octet-stream for a Content-Type that is not a clean type/subtype', async () => {
    const { fileId, tenantId, container } = await uploadAndPublish('not-a-real-mime-type');
    const row = await files.findById(container.pool, tenantId, fileId);
    expect(row?.mime).toBe('application/octet-stream');
  });

  it('the normalized mime is what /s/:slug/download sends as Content-Type', async () => {
    const { fileId, tenantId, container } = await uploadAndPublish('IMAGE/Png');
    const row = await files.findById(container.pool, tenantId, fileId);
    expect(row?.mime).toBe('image/png');

    const app = await buildApp({ container });
    const dl = await app.inject({ method: 'GET', url: `/s/${row!.public_slug}/download` });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('image/png');
  });
});
