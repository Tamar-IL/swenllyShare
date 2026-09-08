import type { FastifyInstance, FastifyError } from 'fastify';
import { AppError, ErrorCode } from '../../lib/errors.js';

/**
 * Every JSON error body is `{error: <code>, message?: <string>}` (architecture.md §11).
 * `AppError` (`lib/errors.ts`) carries its own status/code; anything else is logged as
 * unexpected and reported as a generic 500 — never a raw stack trace or driver error to
 * the client.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      reply.code(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    // fastify's own validation/CSRF/multipart errors carry a `statusCode` but not our
    // `ErrorCode` vocabulary — surface the status, still through the standard body shape.
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (statusCode === 403 && err.code === 'FST_CSRF_INVALID_TOKEN') {
      reply.code(403).send({ error: ErrorCode.INVALID_CSRF, message: err.message });
      return;
    }
    if (statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({ error: ErrorCode.VALIDATION_ERROR, message: err.message });
      return;
    }
    request.log.error({ err }, 'unhandled error');
    reply.code(500).send({ error: ErrorCode.INTERNAL_ERROR });
  });
}
