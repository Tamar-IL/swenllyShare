import { sign as signCookie } from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { TestContainer } from './container.js';

/** Minimal cookie jar for `app.inject()`-based tests: absorbs `Set-Cookie` response
 * headers and replays them as one `Cookie` request header, the way a browser would. */
export class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(setCookieHeaders: string | string[] | undefined): void {
    if (!setCookieHeaders) return;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const header of headers) {
      const pair = header.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  set(name: string, value: string): void {
    this.jar.set(name, value);
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** Performs a real GET to obtain a fresh CSRF cookie + form token, the way a browser
 * submitting the actual form would — so CSRF-protected route tests exercise the real
 * double-submit check rather than working around it. */
export async function getCsrfToken(
  app: FastifyInstance,
  jar: CookieJar,
  path = '/signin',
  opts: { remoteAddress?: string } = {},
): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: path,
    headers: { cookie: jar.header() },
    remoteAddress: opts.remoteAddress,
  });
  jar.absorb(res.headers['set-cookie']);
  const match =
    /name="_csrf" value="([^"]+)"/.exec(res.body) ?? /data-csrf="([^"]+)"/.exec(res.body);
  if (!match?.[1]) {
    throw new Error(`getCsrfToken: no _csrf field found in GET ${path} response body`);
  }
  return match[1];
}

/**
 * Completes magic-link sign-in for `email` through the real domain flow (mints a token,
 * "sends" it via the fake outbound adapter, consumes it) with no HTTP involved, then
 * returns a `swy_sess` cookie header ready to attach to `app.inject()` calls — the
 * shortcut every other integration test uses to get an authenticated session without
 * re-testing the sign-in flow itself each time (that flow has its own dedicated test).
 */
export async function signInAsNewTenant(
  container: TestContainer,
  email: string,
): Promise<{ tenantId: string; cookieHeader: string }> {
  await container.services.auth.requestMagicLink(email);
  const sent = container.fakes.outboundMail.sent.at(-1);
  if (!sent) throw new Error('requestMagicLink did not send a magic-link email');
  const match = /token=([^\s&]+)/.exec(sent.text);
  if (!match?.[1]) throw new Error('magic-link email did not contain a token');

  const { tenant, session } = await container.services.auth.completeSignIn(
    decodeURIComponent(match[1]),
  );
  const signed = signCookie(session.id, container.config.SESSION_SECRET);
  return { tenantId: tenant.id, cookieHeader: `swy_sess=${signed}` };
}
