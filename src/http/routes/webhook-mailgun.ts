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
 */
async function parseWebhookBody(request: FastifyRequest): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type'] ?? '';
  if (contentType.includes('multipart/form-data')) {
    const result: Record<string, unknown> = {};
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        result[part.fieldname] = part.value;
      } else {
        await part.toBuffer().catch(() => undefined);
      }
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
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const payload = await parseWebhookBody(request);
      const result = await container.services.requestPipeline.handleWebhook(payload);
      reply.code(result.status).send();
    },
  );
}
