import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import view from '@fastify/view';
import rateLimit from '@fastify/rate-limit';
import { Eta } from 'eta';
import type { Container } from './container.js';
import { registerAuthPlugin } from './http/plugins/auth.js';
import { registerCsrfPlugin } from './http/plugins/csrf.js';
import { registerSecurityHeaders } from './http/plugins/security-headers.js';
import { registerErrorHandler } from './http/plugins/error-handler.js';
import { registerHealthRoutes } from './http/routes/health.js';
import { registerSignInRoutes } from './http/routes/signin.js';
import { registerFileRoutes } from './http/routes/files.js';
import { registerApiFileRoutes } from './http/routes/api-files.js';
import { registerPublicShareRoutes } from './http/routes/public-share.js';
import { registerWebhookRoutes } from './http/routes/webhook-mailgun.js';

// Same "src/ and dist/ are the same depth under the repo root" reasoning as
// `db/migrate.ts` — views and static assets are never copied by `tsc`, so this must
// resolve to the source tree regardless of whether this runs as `src/app.ts` (via tsx) or
// the compiled `dist/app.js` (architecture.md §1: single-deployable ships the full repo).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, '..', 'src', 'views');
const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'public');

export interface BuildAppOptions {
  container: Container;
}

/**
 * Assembles the full route table (architecture.md §11) on top of the shared plugins:
 * signed-cookie sessions, CSRF, security headers, and the standard JSON error shape.
 * Route registration is additive over the Lane A health checks — HTTP handlers stay thin
 * on purpose, calling exactly one domain service and rendering; no SQL and no business
 * logic live in this file or under `http/routes/*`.
 *
 * Async because route registration below references decorators (`app.csrfProtection`)
 * that third-party plugins only attach once their own `register()` promise resolves —
 * awaiting each registration in order keeps that dependency explicit instead of racing it.
 */
export async function buildApp({ container }: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = container;

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Redaction list per architecture.md §10 — never log secrets or capability
      // tokens, even at debug level.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-mailgun-signature"]',
          'req.headers["x-csrf-token"]',
          'req.body.signature',
          'req.body.token',
          'req.body.request_token',
          'req.body.public_slug',
          'req.body.email',
        ],
        censor: '[redacted]',
      },
    },
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(formbody);
  await app.register(multipart);
  await app.register(staticPlugin, { root: PUBLIC_DIR, prefix: '/assets/' });
  await app.register(view, {
    engine: { eta: new Eta() },
    root: VIEWS_DIR,
    viewExt: 'eta',
    layout: 'layout.eta',
    production: config.NODE_ENV === 'production',
    // Every content template renders inside layout.eta, which reads it.title — most
    // routes don't need a page-specific one, so this is the fallback rather than making
    // every single `reply.view(...)` call repeat it.
    defaultContext: { title: 'Swenlly Share' },
  });
  await app.register(rateLimit, { global: false });
  await registerCsrfPlugin(app);
  await registerSecurityHeaders(app, { BRANDED_PAGE_ENABLED: config.BRANDED_PAGE_ENABLED });

  registerAuthPlugin(app, container);
  registerErrorHandler(app);

  registerHealthRoutes(app, container);
  registerSignInRoutes(app, container);
  registerFileRoutes(app, container);
  registerApiFileRoutes(app, container);
  registerPublicShareRoutes(app, container);
  registerWebhookRoutes(app, container);

  return app;
}
