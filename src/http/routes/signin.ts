import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Container } from '../../container.js';
import { issueCsrfToken } from '../plugins/csrf.js';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../plugins/auth.js';
import { AppError } from '../../lib/errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SignInBody {
  email?: string;
}

/** Sign-in: magic-link request, callback, and sign-out (architecture.md §8, §11). */
export function registerSignInRoutes(app: FastifyInstance, container: Container): void {
  app.get('/', async (request, reply) => {
    if (request.tenantId) return reply.redirect('/files');
    return reply.redirect('/signin');
  });

  app.get('/signin', async (request, reply) => {
    if (request.tenantId) return reply.redirect('/files');
    const csrfToken = await issueCsrfToken(reply);
    return reply.view('signin.eta', { title: 'כניסה', sent: false, csrfToken });
  });

  app.post<{ Body: SignInBody }>(
    '/signin',
    {
      preValidation: app.csrfProtection,
      config: {
        rateLimit: {
          max: container.config.RATE_MAGICLINK_PER_HOUR,
          timeWindow: '1 hour',
          // Bug 6 (QA report): architecture.md §8 promises "per IP and per email," not
          // "per IP regardless of email." A pure-IP key (the previous default) meant a
          // burst of attempts for ONE address behind a shared IP/NAT silently exhausted
          // the budget for every OTHER sender's address behind that same IP. Keying by
          // the (IP, email) pair keeps this dimension scoped to "this IP repeatedly
          // hammering this one address," and stops it from colliding across unrelated
          // senders sharing an IP. The complementary per-email-only dimension (catches
          // one address being targeted from many different IPs) is enforced separately
          // in the Auth domain — see AuthService.requestMagicLink.
          hook: 'preHandler',
          keyGenerator: (request) => {
            const email = ((request.body as SignInBody | undefined)?.email ?? '')
              .trim()
              .toLowerCase();
            return `${request.ip}:${email}`;
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: SignInBody }>, reply) => {
      const email = (request.body?.email ?? '').trim();
      // Always the same "check your mail" response regardless of validity or whether the
      // address is registered (architecture.md §8: no enumeration) — an obviously
      // malformed address is simply never mailed.
      if (EMAIL_RE.test(email)) {
        await container.services.auth.requestMagicLink(email, request.ip);
      }
      const csrfToken = await issueCsrfToken(reply);
      return reply.view('signin.eta', { title: 'כניסה', sent: true, csrfToken });
    },
  );

  app.get<{ Querystring: { token?: string } }>('/auth/callback', async (request, reply) => {
    const token = request.query.token ?? '';
    try {
      const { session } = await container.services.auth.completeSignIn(token);
      reply.setCookie(
        SESSION_COOKIE_NAME,
        session.id,
        sessionCookieOptions(container, session.expires_at),
      );
      return reply.redirect('/files');
    } catch (err) {
      if (err instanceof AppError) {
        reply.code(200);
        return reply.view('error.eta', {
          title: 'שגיאה',
          message: err.message,
          resendHref: '/signin',
        });
      }
      throw err;
    }
  });

  app.post('/signout', { preValidation: app.csrfProtection }, async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE_NAME];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        await container.services.auth.destroySession(unsigned.value);
      }
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return reply.redirect('/signin');
  });
}
