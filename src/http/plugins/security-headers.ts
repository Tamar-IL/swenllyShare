import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';

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
export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameSrc: ['https://workdrive.zohoexternal.com'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
}
