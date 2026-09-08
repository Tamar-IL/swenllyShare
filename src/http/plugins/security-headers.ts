import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';

export interface SecurityHeadersConfig {
  /** F-12 (`docs/security/red-team-report.md`, informational): the global CSP used to
   * advertise `frame-src https://workdrive.zohoexternal.com` on EVERY response
   * unconditionally — including while the branded page is off (the default, until a
   * customer's domain is whitelisted per architecture.md §7) and on pages that never
   * render an iframe at all. That is a white-label leak in exactly the state AC-U3 cares
   * most about hiding it in: the flag-off default. Naming Zoho at all only makes sense
   * once the branded page can actually render its embed. */
  BRANDED_PAGE_ENABLED: boolean;
}

/** CSP and friends (architecture.md §10): the embed iframe is allowed only from Zoho's
 * WorkDrive embed domain, no inline scripts (the island is a plain file), no framing of
 * our own pages by anyone else.
 *
 * `styleSrc`/`fontSrc` (frontend-engineer addition, Lane C): `layout.eta` loads the
 * Assistant typeface from Google Fonts (visual-spec.md §1.3), which needs its stylesheet
 * host (`fonts.googleapis.com`) and the font files it in turn references
 * (`fonts.gstatic.com`). Listed explicitly and nothing else — helmet's own defaults for
 * these two directives are `'self' https: 'unsafe-inline'` (style) and `'self' https:
 * data:` (font), which would already cover Google Fonts via the broad `https:` fallback,
 * but that also re-opens the door to inline `style` attributes and any other HTTPS
 * origin. Naming the two real hosts instead keeps the policy exactly as tight as the
 * page's actual needs. */
export async function registerSecurityHeaders(
  app: FastifyInstance,
  config: SecurityHeadersConfig,
): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // F-12: only named while the branded page can actually serve its embed iframe.
        // With no frame-src directive at all, CSP falls back to default-src ('self'),
        // which already blocks the Zoho frame outright while the flag is off — exactly
        // the flag-off state's own behavior (public-share.ts 404s `/s/:slug` unconditionally
        // when the flag is off, so nothing is ever lost by omitting the allowance here).
        ...(config.BRANDED_PAGE_ENABLED
          ? { frameSrc: ['https://workdrive.zohoexternal.com'] }
          : {}),
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
}
