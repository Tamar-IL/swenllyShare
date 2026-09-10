import pino from 'pino';
import type { Config } from './config.js';

export type Logger = pino.Logger;
export type LogLevel = Config['LOG_LEVEL'];

/**
 * Fix pass 7 (docs/reviews/critic-report.md Minor, deferred from fix pass 5): the ONE
 * redaction list used everywhere a logger is created — `src/app.ts`'s Fastify logger and
 * `container.logger` (below) both use it, so a job/domain log line gets exactly the same
 * "never log secrets or capability tokens" guarantee an HTTP request log already had
 * (architecture.md §10). Kept here, not duplicated in `app.ts`, so the two can never
 * drift apart.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-mailgun-signature"]',
  'req.headers["x-csrf-token"]',
  'req.body.signature',
  'req.body.token',
  'req.body.request_token',
  'req.body.public_slug',
  'req.body.email',
];

/**
 * Builds the one pino instance a process uses for everything that isn't an HTTP
 * request/response line — `container.logger`, injected into jobs and domain services so
 * `console.log`/`console.error` never has to appear outside `src/db/migrate.ts`'s CLI
 * (architecture.md §10, `run-and-deploy.md` item 8). `server.ts` passes this SAME
 * instance to Fastify's `logger` option (`buildApp`) so HTTP-triggered logs and
 * job/domain-triggered logs share one format and one redaction list; `worker.ts` (no
 * Fastify) uses it directly.
 */
export function createLogger(level: LogLevel): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });
}
