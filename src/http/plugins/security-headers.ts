import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';

/** CSP and friends (architecture.md §10): the embed iframe is allowed only from Zoho's
 * WorkDrive embed domain, no inline scripts (the island is a plain file), no framing of
 * our own pages by anyone else. */
export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameSrc: ['https://workdrive.zohoexternal.com'],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
}
