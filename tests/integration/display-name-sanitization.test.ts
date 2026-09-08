import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { signInAsNewTenant, getCsrfToken, CookieJar } from '../setup/http.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildApp } from '../../src/app.js';
import { files } from '../../src/db/repositories/files.js';

/**
 * Findings #5/#6 (docs/security/appsec-review.md): `display_name` and `custom_message`
 * flow verbatim into an outbound email subject/attachment filename/body
 * (`reply-composer.ts`) — neither may carry CR/LF/control characters, and neither may
 * grow unbounded. Covers both entry points: `SettingsService.updateSettings` (the
 * settings-form save) and `FilesService.createStaged` (the initial name, taken from the
 * uploaded filename, before any settings save ever happens).
 */
describe.skipIf(!hasTestDatabase())('displayName / customMessage sanitization', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  describe('SettingsService.updateSettings', () => {
    it('strips CR/LF/control characters and trims displayName and customMessage', async () => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(container, 'strip@example.com');

      const updated = await container.services.settings.updateSettings(
        tenant.id,
        file.id,
        {
          displayName: '  a.pdf\r\nX-Injected: yes  ',
          customMessage: '  hello\r\nBcc: attacker@evil.example\r\nworld  ',
        },
        container.ports.clock,
      );

      expect(updated.display_name).toBe('a.pdfX-Injected: yes');
      expect(updated.display_name).not.toMatch(/[\r\n]/);
      expect(updated.custom_message).toBe('helloBcc: attacker@evil.exampleworld');
      expect(updated.custom_message).not.toMatch(/[\r\n]/);
    });

    it('rejects a displayName over 255 characters with a validation error, writing nothing', async () => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(
        container,
        'toolong-name@example.com',
      );
      const original = file.display_name;

      await expect(
        container.services.settings.updateSettings(
          tenant.id,
          file.id,
          { displayName: 'x'.repeat(256) },
          container.ports.clock,
        ),
      ).rejects.toThrow(/255 characters/);

      const row = await files.findById(container.pool, tenant.id, file.id);
      expect(row?.display_name).toBe(original); // untouched — validated before any write
    });

    it('accepts a displayName at exactly the 255-character cap', async () => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(container, 'exact255@example.com');

      const updated = await container.services.settings.updateSettings(
        tenant.id,
        file.id,
        { displayName: 'y'.repeat(255) },
        container.ports.clock,
      );
      expect(updated.display_name).toHaveLength(255);
    });

    it('rejects a customMessage over 5000 characters with a validation error, writing nothing', async () => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(
        container,
        'toolong-msg@example.com',
      );

      await expect(
        container.services.settings.updateSettings(
          tenant.id,
          file.id,
          { customMessage: 'z'.repeat(5001) },
          container.ports.clock,
        ),
      ).rejects.toThrow(/5000 characters/);

      const row = await files.findById(container.pool, tenant.id, file.id);
      expect(row?.custom_message).toBeNull();
    });

    it('accepts a customMessage at exactly the 5000-character cap, and still allows clearing it to null', async () => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(container, 'exact5000@example.com');

      const updated = await container.services.settings.updateSettings(
        tenant.id,
        file.id,
        { customMessage: 'w'.repeat(5000) },
        container.ports.clock,
      );
      expect(updated.custom_message).toHaveLength(5000);

      const cleared = await container.services.settings.updateSettings(
        tenant.id,
        file.id,
        { customMessage: null },
        container.ports.clock,
      );
      expect(cleared.custom_message).toBeNull();
    });

    it('still rejects an empty (post-strip) displayName exactly as before', async () => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(container, 'emptyname@example.com');

      await expect(
        container.services.settings.updateSettings(
          tenant.id,
          file.id,
          { displayName: '  \r\n\t  ' },
          container.ports.clock,
        ),
      ).rejects.toThrow(/displayName cannot be empty/);
    });
  });

  describe('FilesService.createStaged (the initial name, before any settings save)', () => {
    it('strips CR/LF/control characters from the uploaded filename before it becomes display_name', async () => {
      const container = buildTestContainer();
      const { tenantId } = await signInAsNewTenant(container, 'upload-crlf@example.com');

      const row = await container.services.files.createStaged({
        tenantId,
        stream: Readable.from(Buffer.from('hi')),
        originalName: 'evil.pdf"\r\nContent-Disposition: form-data; name="x"',
        mime: 'application/pdf',
      });

      expect(row.display_name).not.toMatch(/[\r\n]/);
      expect(row.display_name).toBe('evil.pdf"Content-Disposition: form-data; name="x"');
      // `original_name` is an internal audit column, never echoed into an outbound
      // header — left as the client sent it.
      expect(row.original_name).toBe('evil.pdf"\r\nContent-Disposition: form-data; name="x"');
    });

    it('strips NUL bytes (only) from original_name so the insert never 500s, keeping everything else raw', async () => {
      const container = buildTestContainer();
      const { tenantId } = await signInAsNewTenant(container, 'upload-nul@example.com');

      // Fix pass 4, item 3 (surfaced in fix pass 3): Postgres `text` columns cannot
      // store a `\x00` byte at all (`invalid byte sequence for encoding "UTF8": 0x00`),
      // and a multipart filename is entirely client-controlled — nothing upstream
      // rejects one. `original_name` is otherwise a raw audit column (see the CR/LF
      // test above), so only the NUL byte itself is stripped; every other control
      // character and the CR/LF sequence must survive untouched.
      const row = await container.services.files.createStaged({
        tenantId,
        stream: Readable.from(Buffer.from('hi')),
        originalName: 'evil\x00.pdf"\r\nContent-Disposition: form-data; name="x"',
        mime: 'application/pdf',
      });

      expect(row.original_name).toBe('evil.pdf"\r\nContent-Disposition: form-data; name="x"');
      expect(row.original_name).not.toMatch(/\x00/);
      // display_name goes through the broader sanitizer regardless — unaffected by this fix.
      expect(row.display_name).toBe('evil.pdf"Content-Disposition: form-data; name="x"');
    });

    it('truncates a display name over 255 characters rather than failing the upload', async () => {
      const container = buildTestContainer();
      const { tenantId } = await signInAsNewTenant(container, 'upload-long@example.com');

      const row = await container.services.files.createStaged({
        tenantId,
        stream: Readable.from(Buffer.from('hi')),
        originalName: `${'q'.repeat(300)}.pdf`,
        mime: 'application/pdf',
      });

      expect(row.display_name).toHaveLength(255);
    });

    it('falls back to a generic name when the filename is nothing but control characters', async () => {
      const container = buildTestContainer();
      const { tenantId } = await signInAsNewTenant(container, 'upload-allcontrol@example.com');

      // No NUL byte here: this test is about the all-control-characters fallback for
      // display_name, a separate case from NUL-stripping in original_name (covered by
      // its own test above, fix pass 4 item 3).
      const row = await container.services.files.createStaged({
        tenantId,
        stream: Readable.from(Buffer.from('hi')),
        originalName: '\r\n\t',
        mime: 'application/pdf',
      });

      expect(row.display_name).toBe('file');
    });
  });

  describe('settings form (src/views/file-detail.eta)', () => {
    it('renders maxlength attributes matching the server-side caps', async () => {
      const container = buildTestContainer();
      const app = await buildApp({ container });
      const jar = new CookieJar();
      const { cookieHeader } = await signInAsNewTenant(container, 'form-maxlength@example.com');
      jar.set('swy_sess', cookieHeader.split('=')[1]!);

      const csrfToken = await getCsrfToken(app, jar, '/files/new');
      const boundary = '----maxlengthTestBoundary';
      const body = Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="doc.pdf"\r\n' +
          'Content-Type: application/pdf\r\n\r\n' +
          'hello' +
          `\r\n--${boundary}--\r\n`,
      );
      const uploadRes = await app.inject({
        method: 'POST',
        url: '/api/files',
        headers: {
          cookie: jar.header(),
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'x-csrf-token': csrfToken,
        },
        payload: body,
      });
      expect(uploadRes.statusCode).toBe(201);
      const { fileId } = uploadRes.json() as { fileId: string };

      const pageRes = await app.inject({
        method: 'GET',
        url: `/files/${fileId}`,
        headers: { cookie: jar.header() },
      });
      expect(pageRes.statusCode).toBe(200);
      expect(pageRes.body).toContain('name="displayName"');
      expect(pageRes.body).toContain('maxlength="255"');
      expect(pageRes.body).toContain('name="customMessage"');
      expect(pageRes.body).toContain('maxlength="5000"');
    });
  });
});
