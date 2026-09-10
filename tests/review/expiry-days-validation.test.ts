import { describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { CookieJar, getCsrfToken, signInAsNewTenant } from '../setup/http.js';
import { buildApp } from '../../src/app.js';
import { files } from '../../src/db/repositories/files.js';
import { ErrorCode } from '../../src/lib/errors.js';

/**
 * Fix pass 8 (docs/reviews/code-review.md, "Polish pass review — 2026-09-10" finding 1,
 * second half): `SettingsService.updateSettings`'s `days` mode used to distinguish "no
 * day count submitted" from "an explicit, invalid day count submitted" only as far as
 * `resolveExpiry`'s existing `days <= 0` guard could tell — but the HTTP route
 * (`src/http/routes/files.ts`) collapsed BOTH cases (field truly absent, and field
 * present-but-blank) into the same `undefined`, so a blank/garbage `expiryDays` field
 * (exactly what a `<input type="number">` submits when the browser rejects what the
 * user typed) silently fell back to `DEFAULT_EXPIRY_DAYS` instead of surfacing a
 * validation error — quietly overwriting whatever the sender actually intended.
 */
describe.skipIf(!hasTestDatabase())('expiry mode "days" defensive validation', () => {
  it('SettingsService.updateSettings rejects mode=days with an explicit non-positive day count', async () => {
    await truncateAll();
    const container = buildTestContainer({ DEFAULT_EXPIRY_DAYS: 30 });
    const { tenant, file } = await createTenantWithReadyFile(
      container,
      'expiry-days-invalid@example.com',
    );

    await expect(
      container.services.settings.updateSettings(
        tenant.id,
        file.id,
        { expiryMode: 'days', expiryDays: 0 },
        container.ports.clock,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    // Rejected before any write — the file's original expiry is untouched.
    const unchanged = await files.findById(container.pool, tenant.id, file.id);
    expect(unchanged?.expiry_mode).toBe('days');
    expect(unchanged?.expiry_days).toBe(30);
  });

  it('POST /files/:id/settings with expiryMode=days and a blank expiryDays field is rejected, not silently defaulted', async () => {
    await truncateAll();
    const container = buildTestContainer({ DEFAULT_EXPIRY_DAYS: 30 });
    const email = 'expiry-days-blank@example.com';
    const { tenant, file } = await createTenantWithReadyFile(container, email);
    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, email);
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);
    const csrfToken = await getCsrfToken(app, jar, `/files/${file.id}`);

    const res = await app.inject({
      method: 'POST',
      url: `/files/${file.id}/settings`,
      headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrfToken,
        displayName: file.display_name,
        expiryMode: 'days',
        // Exactly what a `type="number"` input submits when the browser clears an
        // invalid value the sender typed — NOT the same as the field being absent.
        expiryDays: '',
        allowlistMode: 'open',
      }).toString(),
    });

    // Old (buggy) behavior: 302 redirect, expiry silently reset to DEFAULT_EXPIRY_DAYS.
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('שגיאה');

    const unchanged = await files.findById(container.pool, tenant.id, file.id);
    expect(unchanged?.expiry_days).toBe(30); // the file's ORIGINAL day count, untouched
  });

  it('POST /files/:id/settings with expiryMode=days and NO expiryDays field falls back to DEFAULT_EXPIRY_DAYS (unchanged, intended behavior)', async () => {
    await truncateAll();
    const container = buildTestContainer({ DEFAULT_EXPIRY_DAYS: 30 });
    const email = 'expiry-days-omitted@example.com';
    const { tenant, file } = await createTenantWithReadyFile(container, email);
    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, email);
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);
    const csrfToken = await getCsrfToken(app, jar, `/files/${file.id}`);

    const res = await app.inject({
      method: 'POST',
      url: `/files/${file.id}/settings`,
      headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrfToken,
        displayName: file.display_name,
        expiryMode: 'days',
        // expiryDays deliberately not included at all.
        allowlistMode: 'open',
      }).toString(),
    });

    expect(res.statusCode).toBe(302);
    const updated = await files.findById(container.pool, tenant.id, file.id);
    expect(updated?.expiry_days).toBe(30);
  });
});
