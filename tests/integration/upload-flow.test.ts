import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { signInAsNewTenant, getCsrfToken, CookieJar } from '../setup/http.js';
import { buildMultipartUpload } from '../setup/multipart.js';
import { buildApp } from '../../src/app.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';

describe.skipIf(!hasTestDatabase())('upload flow (AC-U1)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('upload -> publish -> the per-file page shows a distribution link, mailto with the token, and editable settings', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });

    const jar = new CookieJar();
    const { tenantId, cookieHeader } = await signInAsNewTenant(container, 'uploader@example.com');
    jar.set('swy_sess', cookieHeader.split('=')[1]!);

    const csrfToken = await getCsrfToken(app, jar, '/files/new');
    const { body, contentType } = buildMultipartUpload({
      fieldName: 'file',
      filename: 'report.pdf',
      content: Buffer.from('hello world'),
      contentType: 'application/pdf',
    });

    const uploadRes = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: { cookie: jar.header(), 'content-type': contentType, 'x-csrf-token': csrfToken },
      payload: body,
    });

    expect(uploadRes.statusCode).toBe(201);
    const { fileId, status } = uploadRes.json() as { fileId: string; status: string };
    expect(status).toBe('staged');

    // Drain the file.publish job synchronously instead of waiting on the real worker loop.
    await runPendingJobs(container);

    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/files/${fileId}/status`,
      headers: { cookie: jar.header() },
    });
    expect(statusRes.json()).toMatchObject({ status: 'ready', publishStep: 'ready' });

    const row = (await files.findById(container.pool, tenantId, fileId))!;
    expect(row.status).toBe('ready');
    expect(row.zoho_public_link).toMatch(/^https:\/\/workdrive\.zohoexternal\.com\//);

    const pageRes = await app.inject({
      method: 'GET',
      url: `/files/${fileId}`,
      headers: { cookie: jar.header() },
    });
    expect(pageRes.statusCode).toBe(200);
    // Default flag off -> distribution link is the raw Zoho public link (AC-U2 territory,
    // but the per-file page must render *some* link once ready).
    expect(pageRes.body).toContain('workdrive.zohoexternal.com');
    // The mailto link carries this file's own request_token, not a made-up one.
    expect(pageRes.body).toContain(row.request_token);
    expect(pageRes.body).toContain('mailto:cust-');

    // Settings are editable: change the display name and custom message.
    const settingsCsrf = await getCsrfToken(app, jar, `/files/${fileId}`);
    const saveRes = await app.inject({
      method: 'POST',
      url: `/files/${fileId}/settings`,
      headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: settingsCsrf,
        displayName: 'Renamed Report.pdf',
        customMessage: 'here you go',
        expiryMode: 'none',
        allowlistMode: 'open',
      }).toString(),
    });
    expect(saveRes.statusCode).toBe(302);
    expect(saveRes.headers.location).toContain(`/files/${fileId}`);

    const updated = await files.findById(container.pool, tenantId, fileId);
    expect(updated?.display_name).toBe('Renamed Report.pdf');
    expect(updated?.custom_message).toBe('here you go');
    expect(updated?.expires_at).toBeNull();
  });

  it('rejects an upload above MAX_UPLOAD_BYTES with 413 too_large', async () => {
    const container = buildTestContainer({ MAX_UPLOAD_BYTES: 1024 });
    const app = await buildApp({ container });
    const jar = new CookieJar();
    const { cookieHeader } = await signInAsNewTenant(container, 'toobig@example.com');
    jar.set('swy_sess', cookieHeader.split('=')[1]!);
    const csrfToken = await getCsrfToken(app, jar, '/files/new');

    const { body, contentType } = buildMultipartUpload({
      fieldName: 'file',
      filename: 'huge.bin',
      content: Buffer.alloc(2048, 1),
      contentType: 'application/octet-stream',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: { cookie: jar.header(), 'content-type': contentType, 'x-csrf-token': csrfToken },
      payload: body,
    });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'too_large', maxBytes: 1024 });
  });
});
