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

  // Fix pass 7 (docs/reviews/critic-report.md Minor): pass `container.logger` (built by
  // `server.ts`/`worker.ts`, `src/logger.ts`) in via Fastify 5's `loggerInstance` option
  // (a pre-built pino instance — the plain `logger` option only accepts a config object
  // as of Fastify 5, not an instance) rather than building a second, separately-
  // configured pino here. This is the change that makes an HTTP request log and a
  // job/domain log line (`container.logger.info(...)`) share the exact same redaction
  // list (architecture.md §10) instead of two lists that could silently drift apart.
  //
  // The cast is a type-level-only friction, not a behavior change: passing
  // `loggerInstance` makes TS infer this instance's exact (pino) logger type as
  // `FastifyInstance`'s Logger generic, which then fails to structurally satisfy the
  // plain `FastifyBaseLogger` every route-registration function below (and everywhere
  // else in this codebase) is typed against. The runtime object is unchanged — still
  // `container.logger`, still logging through the same redaction list.
  const app = Fastify({ loggerInstance: container.logger }) as unknown as FastifyInstance;

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
