import type { FastifyReply, FastifyRequest } from 'fastify';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Fix pass 10 (critic R-5): a non-UUID path id used to reach Postgres and surface as an
 * unhandled `22P02` (HTTP 500), contradicting the "a wrong id gets a plain 404, never a
 * distinguishing detail" contract of the tenant-scoped routes. This preHandler turns any
 * malformed id into the same 404 a foreign tenant's id gets. `render` lets HTML routes
 * and JSON routes each keep their own 404 body.
 */
export function requireUuidParams(
  names: readonly string[],
  render: (reply: FastifyReply) => Promise<void> | void,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    for (const name of names) {
      if (!isUuid(params[name])) {
        await render(reply);
        return;
      }
    }
  };
}
