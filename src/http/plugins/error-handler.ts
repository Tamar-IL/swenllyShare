import type { FastifyInstance, FastifyError } from 'fastify';
import { AppError, ErrorCode } from '../../lib/errors.js';

/**
 * Bug 8 (`docs/qa/qa-report-sender-app.md`): a client cancelling an in-progress request
 * (e.g. the upload dropzone's "בטל" mid-upload) surfaces here as a plain socket reset —
 * `ECONNRESET`/`ECONNABORTED`/`EPIPE` — not an application fault. Node's http/multipart
 * machinery reports this as an ordinary thrown `Error` with one of these `code`s, no
 * `statusCode` of its own, so it would otherwise fall through to the generic 500/`error`-
 * level branch below on every single legitimate cancel click.
 */
export function isClientAbortError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE';
}

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
    if (isClientAbortError(err)) {
      // Expected, routine — never an "unhandled error" / error-rate-dashboard event.
      request.log.info({ err }, 'client aborted the request');
      reply.code(500).send({ error: ErrorCode.INTERNAL_ERROR });
      return;
    }
    request.log.error({ err }, 'unhandled error');
    reply.code(500).send({ error: ErrorCode.INTERNAL_ERROR });
  });
}
