import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { jobs } from '../../db/repositories/jobs.js';

export function registerHealthRoutes(app: FastifyInstance, container: Container): void {
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await container.pool.query('SELECT 1');
      const pendingJobs = await jobs.countPending(container.pool);
      return { ok: true, db: true, pendingJobs };
    } catch (err) {
      app.log.error({ err }, 'readyz: database check failed');
      reply.code(503);
      return { ok: false, db: false, pendingJobs: 0 };
    }
  });
}
