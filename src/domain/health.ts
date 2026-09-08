import type { Pool } from '../db/pool.js';
import { jobs } from '../db/repositories/jobs.js';
import { files } from '../db/repositories/files.js';
import { deliveries } from '../db/repositories/deliveries.js';

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

  /** Fix pass 5, F-C (docs/reviews/critic-report.md): `/readyz`'s count of files whose
   * `file.expire` job has dead-lettered at least once and never since recovered — see
   * `files.recordExpiryError`/`clearExpiryError`. Zero doesn't mean nothing ever failed,
   * only that nothing is CURRENTLY stuck. */
  async countStrandedExpiries(): Promise<number> {
    return files.countStrandedExpiries(this.pool);
  }

  /** Fix pass 6 (critic N-2): deliveries finalized `unconfirmed` (an ambiguous send —
   * see `delivery-fulfill.ts`). Surfaced so a deploy-restart that strands a delivery is
   * visible to the operator rather than silently absorbed into the audit log. */
  async countUnconfirmedDeliveries(): Promise<number> {
    return deliveries.countUnconfirmed(this.pool);
  }
}
