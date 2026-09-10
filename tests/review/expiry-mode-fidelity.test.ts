import { describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { CookieJar, getCsrfToken, signInAsNewTenant } from '../setup/http.js';
import { buildApp } from '../../src/app.js';
import { files } from '../../src/db/repositories/files.js';

/**
 * Fix pass 7 (docs/reviews/critic-report.md Minor, deferred since fix pass 5): "an
 * existing expiry always renders as custom date, never as the 30-day radio" —
 * `http/routes/files.ts` used to derive the pre-selected radio from `file.expires_at ?
 * 'custom' : 'none'`, so an ordinary `days`-mode expiry (every file gets one by default,
 * `DEFAULT_EXPIRY_DAYS`) always rendered as "custom date". `files.expiry_mode`/
 * `expiry_days` (migration 0006) now persist the form's own choice, and the per-file
 * page reads it back instead of reverse-guessing from the raw timestamp.
 */
describe.skipIf(!hasTestDatabase())('expiry mode fidelity', () => {
  it('a freshly created file defaults to days mode at DEFAULT_EXPIRY_DAYS, both in the DB and on the page', async () => {
    await truncateAll();
    const container = buildTestContainer({ DEFAULT_EXPIRY_DAYS: 30 });
    const email = 'expiry-default@example.com';
    const { file } = await createTenantWithReadyFile(container, email);

    expect(file.expiry_mode).toBe('days');
    expect(file.expiry_days).toBe(30);
    expect(file.expires_at).not.toBeNull();

    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, email); // same email -> same tenant, fresh session
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);

    const res = await app.inject({
      method: 'GET',
      url: `/files/${file.id}`,
      headers: { cookie: jar.header() },
    });
    expect(res.statusCode).toBe(200);
    // The `days` radio is checked, pre-filled with the file's OWN stored day count —
    // never the hardcoded `value="30"` the old template shipped regardless of the
    // configured default.
    expect(res.body).toMatch(/<input type="radio" name="expiryMode" value="days" checked/);
    expect(res.body).toContain('name="expiryDays" min="1" value="30"');
    expect(res.body).not.toMatch(/<input type="radio" name="expiryMode" value="custom" checked/);
  });

  it('switching to custom-date mode persists the mode, not just the derived timestamp, and the page reflects it', async () => {
    await truncateAll();
    const container = buildTestContainer();
    const email = 'expiry-custom@example.com';
    const { tenant, file } = await createTenantWithReadyFile(container, email);
    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, email);
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);
    const csrfToken = await getCsrfToken(app, jar, `/files/${file.id}`);

    const customDate = '2027-01-15';
    const postRes = await app.inject({
      method: 'POST',
      url: `/files/${file.id}/settings`,
      headers: {
        cookie: jar.header(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        _csrf: csrfToken,
        displayName: file.display_name,
        expiryMode: 'custom',
        expiresAt: customDate,
        allowlistMode: 'open',
      }).toString(),
    });
    expect(postRes.statusCode).toBe(302);

    const updated = await files.findById(container.pool, tenant.id, file.id);
    expect(updated?.expiry_mode).toBe('custom');
    expect(updated?.expiry_days).toBeNull();

    const getRes = await app.inject({
      method: 'GET',
      url: `/files/${file.id}`,
      headers: { cookie: jar.header() },
    });
    expect(getRes.body).toMatch(/<input type="radio" name="expiryMode" value="custom" checked/);
    expect(getRes.body).toContain(`value="${customDate}"`);
    expect(getRes.body).not.toMatch(/<input type="radio" name="expiryMode" value="days" checked/);
  });

  it('switching to no-expiry mode persists expiry_mode=none and clears expiry_days', async () => {
    await truncateAll();
    const container = buildTestContainer();
    const email = 'expiry-none@example.com';
    const { tenant, file } = await createTenantWithReadyFile(container, email);
    const app = await buildApp({ container });
    const { cookieHeader } = await signInAsNewTenant(container, email);
    const jar = new CookieJar();
    jar.set('swy_sess', cookieHeader.split('=')[1]!);
    const csrfToken = await getCsrfToken(app, jar, `/files/${file.id}`);

    const postRes = await app.inject({
      method: 'POST',
      url: `/files/${file.id}/settings`,
      headers: {
        cookie: jar.header(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        _csrf: csrfToken,
        displayName: file.display_name,
        expiryMode: 'none',
        allowlistMode: 'open',
      }).toString(),
    });
    expect(postRes.statusCode).toBe(302);

    const updated = await files.findById(container.pool, tenant.id, file.id);
    expect(updated?.expiry_mode).toBe('none');
    expect(updated?.expiry_days).toBeNull();
    expect(updated?.expires_at).toBeNull();
  });
});
