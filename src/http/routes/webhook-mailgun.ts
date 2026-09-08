import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Container } from '../../container.js';

/**
 * Reads Mailgun's inbound-route payload regardless of whether it arrived
 * `application/x-www-form-urlencoded` (parsed by `@fastify/formbody` into `request.body`)
 * or `multipart/form-data` (Mailgun's shape when the original message carried
 * attachments) — the exact content type Mailgun uses is one of the UNVERIFIED items
 * (architecture.md §12), so this route accepts either rather than assuming one. Any file
 * parts are drained and discarded: an inbound reply's *attachments* are never part of how
 * a request resolves (architecture.md §4 — only the recipient token does), so there is
 * nothing to do with them here.
 *
 * F-10 (`docs/security/red-team-report.md`, RT-40): the multipart branch used to collect
 * every field before returning, so gate 1's HMAC check — the route's ONLY authentication —
 * ran only after the entire body had already been buffered. `verify()` needs exactly
 * `timestamp`/`token`/`signature`, and Mailgun's own webhook form always emits them (they
 * are its documented, stable fields), so as soon as all three have been seen this stops
 * reading further parts and returns immediately — an attacker who front-loads 25 MiB of
 * junk fields ahead of those three gets nothing for it; one who puts them last still hits
 * the route-level `bodyLimit`/`limits` caps below before the read completes.
 */
async function parseWebhookBody(
  request: FastifyRequest,
  limits: { fieldSize: number; fields: number; parts: number },
): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type'] ?? '';
  if (contentType.includes('multipart/form-data')) {
    const result: Record<string, unknown> = {};
    const wanted = new Set(['timestamp', 'token', 'signature']);
    for await (const part of request.parts({ limits })) {
      if (part.type === 'field') {
        result[part.fieldname] = part.value;
        wanted.delete(part.fieldname);
      } else {
        await part.toBuffer().catch(() => undefined);
      }
      if (wanted.size === 0) break; // F-10: stop reading once auth fields are in hand
    }
    return result;
  }
  return (request.body as Record<string, unknown>) ?? {};
}

/**
 * `POST /webhooks/mailgun/inbound` (architecture.md §4, §11). No session, no CSRF (HMAC
 * verification inside `RequestPipeline.handleWebhook` is the authentication) — this route
 * lives on its own `/webhooks/*` prefix specifically so that exemption never needs a
 * per-route flag anywhere else.
 */
export function registerWebhookRoutes(app: FastifyInstance, container: Container): void {
  app.post(
    '/webhooks/mailgun/inbound',
    {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      // F-10: caps the RAW body size for the (Fastify-core-parsed) urlencoded branch —
      // this was already 413-capped by Fastify's own 1 MB default, but WEBHOOK_BODY_LIMIT_
      // BYTES makes that an explicit, documented, sized-to-Mailgun's-real-ceiling choice
      // instead of an accidental default.
      bodyLimit: container.config.WEBHOOK_BODY_LIMIT_BYTES,
    },
    async (request, reply) => {
      // F-10: the multipart branch bypasses Fastify's own core `bodyLimit` enforcement
      // (that machinery is for its built-in JSON/text/urlencoded parsers; `@fastify/
      // multipart` streams instead of buffering through it) — so this route checks
      // `Content-Length` itself, before `request.parts()` reads a single byte, for the
      // common case where it's present and honest. The "stop once the three auth fields
      // are in hand" early-exit in `parseWebhookBody` below is the second layer, for a
      // request that lies about (or omits) `Content-Length`.
      const contentLength = Number(request.headers['content-length'] ?? NaN);
      if (
        Number.isFinite(contentLength) &&
        contentLength > container.config.WEBHOOK_BODY_LIMIT_BYTES
      ) {
        reply.code(413).send();
        return;
      }

      const payload = await parseWebhookBody(request, {
        fieldSize: container.config.WEBHOOK_BODY_LIMIT_BYTES,
        fields: 1000,
        parts: 1000,
      });
      const result = await container.services.requestPipeline.handleWebhook(payload);
      reply.code(result.status).send();
    },
  );
}
