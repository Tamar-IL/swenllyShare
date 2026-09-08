import type pg from 'pg';
import { deliveries, type DeliveryRow } from '../db/repositories/deliveries.js';

/**
 * The per-file deliveries feed (AC-A2, `GET /api/files/:id/deliveries`). Every terminal
 * pipeline/job outcome writes a `deliveries` row (architecture.md §3 invariant 4); this
 * service is the read side.
 */
export class AuditService {
  constructor(private readonly pool: pg.Pool) {}

  async listForFile(
    tenantId: string,
    fileId: string,
    opts: { since?: Date; limit?: number } = {},
  ): Promise<{ items: DeliveryRow[]; total: number }> {
    const [items, total] = await Promise.all([
      deliveries.listForFile(this.pool, tenantId, fileId, opts),
      deliveries.countForFile(this.pool, tenantId, fileId),
    ]);
    return { items, total };
  }
}
