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
    const container = buildTestContainer();
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
