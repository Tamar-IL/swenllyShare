import type { FastifyInstance, FastifyReply } from 'fastify';
import csrfProtection from '@fastify/csrf-protection';

/**
 * Double-submit CSRF token on every state-changing form (architecture.md §8). Registered
 * once at the top level; the webhook route is exempt simply by never attaching
 * `app.csrfProtection` as that route's `onRequest` hook — it authenticates by HMAC
 * instead and lives on its own `/webhooks/*` path prefix, so the exemption is a routing
 * fact, not a bypass flag threaded through shared middleware.
 */
export async function registerCsrfPlugin(app: FastifyInstance): Promise<void> {
  await app.register(csrfProtection, { cookieOpts: { signed: true, path: '/' } });
}

/** Mints (or reuses) this session's CSRF token for embedding in a form's hidden `_csrf`
 * field or the island's `x-csrf-token` XHR header. */
export async function issueCsrfToken(reply: FastifyReply): Promise<string> {
  return reply.generateCsrf();
}
