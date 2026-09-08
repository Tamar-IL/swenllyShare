import type { Pool } from '../db/pool.js';
import { jobs } from '../db/repositories/jobs.js';

/**
 * Read-side ops primitives for `GET /readyz` (architecture.md §2 boundary rule 1: HTTP
 * handlers contain no SQL, so `src/http/routes/health.ts` may not import
 * `db/repositories/jobs.js` directly). Deliberately thin — the readiness POLICY (which
 * sweep kinds to check, how stale is too stale) stays in the route, which already owns
 * `PERIODIC_SWEEP_INTERVAL_MINUTES` (`src/jobs/queue.ts`) and assembles the `/readyz`
 * response shape; this service only reaches through the repository the route may not.
 */
export class HealthService {
  constructor(private readonly pool: Pool) {}

  async countPendingJobs(): Promise<number> {
    return jobs.countPending(this.pool);
  }

  /** Most recent `created_at` among jobs of `kind` — `/readyz`'s "has this periodic
   * sweep actually been scheduled recently" freshness check. */
  async mostRecentScheduledAt(kind: string): Promise<Date | null> {
    return jobs.mostRecentScheduledAt(this.pool, kind);
  }
}
