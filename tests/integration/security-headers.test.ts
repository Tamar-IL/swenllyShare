import { describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { buildApp } from '../../src/app.js';

/**
 * CSP (architecture.md §10, visual-spec.md §1.3): the layout loads Google Fonts, which
 * needs `style-src`/`font-src` to allow `fonts.googleapis.com`/`fonts.gstatic.com` — but
 * that addition must never widen `script-src` past `'self'`, since the island is a plain
 * file with no inline handlers (frontend-engineer task brief, §10 CSP requirement).
 */
describe.skipIf(!hasTestDatabase())('CSP headers (architecture.md §10)', () => {
  it('GET /signin sends a CSP that allows Google Fonts but still forbids inline scripts', async () => {
    // F-12 (docs/security/red-team-report.md): frame-src only names the Zoho embed
    // origin while the branded page is enabled (see the dedicated test below for the
    // flag-off case) -- explicitly on here so this test still exercises that directive.
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: true });
    const app = await buildApp({ container });

    const res = await app.inject({ method: 'GET', url: '/signin' });
    expect(res.statusCode).toBe(200);

    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    const value = String(csp);

    // script-src stays locked to 'self' — no 'unsafe-inline', no 'unsafe-eval', no
    // wildcard host that would let an injected <script> or inline handler run.
    expect(value).toMatch(/script-src 'self'(;|$)/);
    expect(value).not.toContain('unsafe-inline');
    expect(value).not.toContain('unsafe-eval');

    // Google Fonts is allowed, and only Google Fonts — not a broad "https:" fallback.
    expect(value).toContain('style-src');
    expect(value).toContain('https://fonts.googleapis.com');
    expect(value).toContain('font-src');
    expect(value).toContain('https://fonts.gstatic.com');

    // The embed frame allowance and framing lockdown from architecture.md §10 are
    // untouched by the font-loading change.
    expect(value).toContain('frame-src https://workdrive.zohoexternal.com');
    expect(value).toContain("frame-ancestors 'none'");
  });

  it(
    'F-12 fix: GET /signin does NOT name the Zoho embed origin in its CSP while the ' +
      'branded page is off (the default, until a customer domain is whitelisted) -- ' +
      'previously the global CSP advertised frame-src unconditionally on EVERY response, ' +
      'a white-label leak in exactly the state AC-U3 cares most about hiding it in',
    async () => {
      const container = buildTestContainer({ BRANDED_PAGE_ENABLED: false });
      const app = await buildApp({ container });

      const res = await app.inject({ method: 'GET', url: '/signin' });
      expect(res.statusCode).toBe(200);
      const csp = String(res.headers['content-security-policy']);
      expect(csp).not.toContain('workdrive.zohoexternal.com');
      expect(csp).not.toContain('frame-src');
      // Framing lockdown and everything else stay untouched by the flag.
      expect(csp).toContain("frame-ancestors 'none'");
    },
  );

  it('the rendered <head> only ever references self-hosted or allow-listed font origins', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });

    const res = await app.inject({ method: 'GET', url: '/signin' });
    expect(res.body).toContain('https://fonts.googleapis.com');
    // No inline <script> and no inline event-handler attribute anywhere in the shell.
    expect(res.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[^<]/);
    expect(res.body).not.toMatch(/\son[a-z]+="/i);
  });
});
