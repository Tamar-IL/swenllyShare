import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from './config.js';
import { AppError, ErrorCode } from './lib/errors.js';
import { jobs } from './db/repositories/jobs.js';

export interface BuildAppOptions {
  config: Config;
  pool: pg.Pool;
}

/**
 * Minimal app factory: `/healthz` and `/readyz` only. Lane B (backend-engineer) extends
 * this with the real route table (architecture.md §11) — HTTP handlers stay thin here
 * on purpose so that extension is additive, not a rewrite.
 */
export function buildApp({ config, pool }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Redaction list per architecture.md §10 — never log secrets or capability
      // tokens, even at debug level.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-mailgun-signature"]',
          'req.body.signature',
          'req.body.token',
          'req.body.request_token',
          'req.body.public_slug',
        ],
        censor: '[redacted]',
      },
    },
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      const pendingJobs = await jobs.countPending(pool);
      return { ok: true, db: true, pendingJobs };
    } catch (err) {
      app.log.error({ err }, 'readyz: database check failed');
      reply.code(503);
      return { ok: false, db: false, pendingJobs: 0 };
    }
  });

  // Error handler stub (architecture.md §11: every JSON error body is
  // `{error: <code>, message?: <string>}`). Lane B's routes throw `AppError` for
  // anything with a defined code; anything else is an unexpected 500.
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      reply.code(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    request.log.error({ err }, 'unhandled error');
    reply.code(500).send({ error: ErrorCode.INTERNAL_ERROR });
  });

  return app;
}
