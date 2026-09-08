import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { PERIODIC_SWEEP_INTERVAL_MINUTES } from '../../jobs/queue.js';

// F-5: how stale a sweep kind's most recent scheduling can be before /readyz calls it
// unhealthy — generous headroom over PERIODIC_SWEEP_INTERVAL_MINUTES so a slow tick or a
// worker restart doesn't flap readiness.
const SWEEP_STALE_AFTER_MINUTES = PERIODIC_SWEEP_INTERVAL_MINUTES * 4;
const SWEEP_KINDS = ['staging.purge', 'inbound.purge', 'expiry.safety_sweep'] as const;

export function registerHealthRoutes(app: FastifyInstance, container: Container): void {
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await container.pool.query('SELECT 1');
      const pendingJobs = await container.services.health.countPendingJobs();

      // F-5 (docs/security/red-team-report.md, RT-50..RT-54): a handler that's never
      // scheduled isn't a control — this surfaces "the recurring sweeps are actually
      // being enqueued" as a readiness fact, not just "the handlers exist and pass their
      // own unit tests".
      const now = container.ports.clock.now().getTime();
      const staleAfterMs = SWEEP_STALE_AFTER_MINUTES * 60_000;
      const sweeps: Record<string, { lastScheduledAt: string | null; healthy: boolean }> = {};
      let sweepsHealthy = true;
      for (const kind of SWEEP_KINDS) {
        const lastScheduledAt = await container.services.health.mostRecentScheduledAt(kind);
        const healthy = lastScheduledAt !== null && now - lastScheduledAt.getTime() <= staleAfterMs;
        sweeps[kind] = { lastScheduledAt: lastScheduledAt?.toISOString() ?? null, healthy };
        if (!healthy) sweepsHealthy = false;
      }

      return { ok: true, db: true, pendingJobs, sweepsHealthy, sweeps };
    } catch (err) {
      app.log.error({ err }, 'readyz: database check failed');
      reply.code(503);
      return { ok: false, db: false, pendingJobs: 0, sweepsHealthy: false, sweeps: {} };
    }
  });
}
