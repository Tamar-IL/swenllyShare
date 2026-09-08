import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Container } from '../../container.js';
import { AppError, ErrorCode } from '../../lib/errors.js';

export const SESSION_COOKIE_NAME = 'swy_sess';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId?: string;
  }
}

/**
 * Resolves the `swy_sess` signed cookie into `request.tenantId` on every request
 * (architecture.md §8). Sliding refresh: `AuthService.touchSession` only actually writes
 * (and this plugin only reissues the cookie) at most once per hour per session, so a busy
 * session doesn't generate a write — or a `Set-Cookie` — on every request.
 *
 * Registered directly against the root `app` instance (not via `app.register(...)`) so
 * its hook and decorator apply everywhere without needing the `fastify-plugin`
 * encapsulation-bypass package as an extra dependency.
 */
export function registerAuthPlugin(app: FastifyInstance, container: Container): void {
  app.decorateRequest('tenantId', undefined);

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = request.cookies[SESSION_COOKIE_NAME];
    if (!raw) return;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;

    const sessionId = unsigned.value;
    const resolved = await container.services.auth.resolveSession(sessionId);
    if (!resolved) return;

    request.tenantId = resolved.tenantId;

    const touched = await container.services.auth.touchSession(sessionId);
    if (touched) {
      reply.setCookie(
        SESSION_COOKIE_NAME,
        sessionId,
        sessionCookieOptions(container, touched.expires_at),
      );
    }
  });
}

export function sessionCookieOptions(container: Container, expiresAt: Date) {
  return {
    path: '/',
    httpOnly: true,
    secure: container.config.COOKIE_SECURE,
    sameSite: 'lax' as const,
    signed: true,
    expires: expiresAt,
  };
}

/** preHandler for JSON/API routes: 401 with the standard error body when unauthenticated. */
export async function requireSessionApi(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.tenantId) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'session required');
  }
}

/** preHandler for HTML routes: redirects to `/signin` instead of rendering a 401 page. */
export async function requireSessionHtml(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.tenantId) {
    await reply.redirect('/signin');
  }
}
