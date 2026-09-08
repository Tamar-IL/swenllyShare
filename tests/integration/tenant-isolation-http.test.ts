import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { signInAsNewTenant, CookieJar, getCsrfToken } from '../setup/http.js';
import { buildApp } from '../../src/app.js';
import { files } from '../../src/db/repositories/files.js';

/**
 * HTTP-level AC-A3: tenant B holding a valid session must get a plain 404 for tenant A's
 * resources — never a 403 (which would at least confirm the resource id is real). This
 * complements (does not duplicate) the repository-level `tests/integration/tenant-
 * isolation.test.ts` from Lane A/database-engineer.
 */
describe.skipIf(!hasTestDatabase())('tenant isolation over HTTP (AC-A3)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("GET /files/:id for another tenant's file -> 404 HTML, never 403", async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const { file } = await createTenantWithReadyFile(container, 'owner@example.com');
    const { cookieHeader: otherCookie } = await signInAsNewTenant(
      container,
      'intruder@example.com',
    );

    const jar = new CookieJar();
    jar.set('swy_sess', otherCookie.split('=')[1]!);

    const res = await app.inject({
      method: 'GET',
      url: `/files/${file.id}`,
      headers: { cookie: jar.header() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(file.display_name);
  });

  it("GET /api/files/:id/status for another tenant's file -> 404 JSON, never 403", async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const { file } = await createTenantWithReadyFile(container, 'owner2@example.com');
    const { cookieHeader: otherCookie } = await signInAsNewTenant(
      container,
      'intruder2@example.com',
    );

    const jar = new CookieJar();
    jar.set('swy_sess', otherCookie.split('=')[1]!);

    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${file.id}/status`,
      headers: { cookie: jar.header() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it("POST /files/:id/settings for another tenant's file -> 404, and the real owner's settings are unchanged", async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'owner3@example.com');
    const { cookieHeader: otherCookie } = await signInAsNewTenant(
      container,
      'intruder3@example.com',
    );

    const jar = new CookieJar();
    jar.set('swy_sess', otherCookie.split('=')[1]!);
    const csrfToken = await getCsrfToken(app, jar, '/files/new');

    const res = await app.inject({
      method: 'POST',
      url: `/files/${file.id}/settings`,
      headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrfToken,
        displayName: 'hijacked.pdf',
        expiryMode: 'none',
        allowlistMode: 'open',
      }).toString(),
    });
    expect(res.statusCode).toBe(404);

    const untouched = await files.findById(container.pool, tenant.id, file.id);
    expect(untouched?.display_name).toBe(file.display_name);
  });

  it('an unauthenticated request to a protected page redirects to /signin, not a 401/403 page', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const res = await app.inject({ method: 'GET', url: '/files' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/signin');
  });

  it('an unauthenticated API request gets a JSON 401', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const res = await app.inject({
      method: 'GET',
      url: '/api/files/00000000-0000-0000-0000-000000000000/status',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });
});
