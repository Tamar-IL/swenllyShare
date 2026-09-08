import type { Pool } from '../db/pool.js';
import { deliveries, type DeliveryRow } from '../db/repositories/deliveries.js';

/**
 * The per-file deliveries feed (AC-A2, `GET /api/files/:id/deliveries`). Every terminal
 * pipeline/job outcome writes a `deliveries` row (architecture.md §3 invariant 4); this
 * service is the read side.
 */
export class AuditService {
  constructor(private readonly pool: Pool) {}

  async listForFile(
    tenantId: string,
    fileId: string,
    opts: { since?: Date; sinceId?: string; limit?: number } = {},
  ): Promise<{ items: DeliveryRow[]; total: number }> {
    const [items, total] = await Promise.all([
      deliveries.listForFile(this.pool, tenantId, fileId, opts),
      deliveries.countForFile(this.pool, tenantId, fileId),
    ]);
    return { items, total };
  }

  /** Boundary rule 1 (architecture.md §2): the `/files` list page's "נשלח ל-N" mini
   * delivery count, wrapped here so `src/http/routes/files.ts` doesn't need its own
   * `deliveries` repository import. */
  async countsSentByTenant(tenantId: string): Promise<Map<string, number>> {
    return deliveries.countsSentByTenant(this.pool, tenantId);
  }
}
