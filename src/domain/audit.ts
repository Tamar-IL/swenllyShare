import { withTransaction, type Pool } from '../db/pool.js';
import { deliveries, type DeliveryRow } from '../db/repositories/deliveries.js';
import { jobs } from '../db/repositories/jobs.js';
import type { RateLimitService } from './rate-limit.js';

/**
 * Fix pass 7 (critic N-2, "no way to resend"): `AuditService.resendDelivery`'s possible
 * outcomes — a discriminated union rather than throwing, so the route can map each one
 * to the exact HTTP status the task requires (404/409/429) without `instanceof` checks
 * on a generic `AppError`.
 */
export type ResendResult =
  | { status: 'ok'; deliveryId: string }
  | { status: 'not_found' }
  | { status: 'wrong_outcome' }
  | { status: 'rate_limited' };

/**
 * The per-file deliveries feed (AC-A2, `GET /api/files/:id/deliveries`). Every terminal
 * pipeline/job outcome writes a `deliveries` row (architecture.md §3 invariant 4); this
 * service is the read side.
 */
export class AuditService {
  constructor(
    private readonly pool: Pool,
    private readonly rateLimit: RateLimitService,
  ) {}

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

  /**
   * Fix pass 7 (critic N-2, "no way to resend"): `POST /files/:id/deliveries/:id/resend`.
   * Only `failed`/`unconfirmed` deliveries are resendable — `queued`/`sending`/
   * `dispatching`/`granted` are still in flight (resending would race the original job,
   * not help it) and every other outcome (`sent`, `quarantined`, `rate_limited`,
   * `expired`, `not_allowlisted`) was never a delivery attempt to retry in the first
   * place. Creates a NEW `deliveries` row and enqueues `delivery.fulfill` for it in ONE
   * transaction — the same append-then-complete outbox shape the inbound pipeline's own
   * gate 10 uses (architecture.md §3 invariant 4, `RequestPipeline.handleWebhook`), so a
   * crash between the insert and the enqueue is impossible, not just unlikely.
   */
  async resendDelivery(
    tenantId: string,
    fileId: string,
    deliveryId: string,
  ): Promise<ResendResult> {
    const original = await deliveries.findById(this.pool, tenantId, fileId, deliveryId);
    if (!original || original.requester_address === null) {
      // A `null` requester_address (the F-7/gate-6 "we don't know who this was"
      // aggregate/unparseable-From rows, migration 0006) has nowhere to resend to —
      // treated the same as not-found rather than a distinct error the UI has to explain.
      return { status: 'not_found' };
    }
    if (original.outcome !== 'failed' && original.outcome !== 'unconfirmed') {
      return { status: 'wrong_outcome' };
    }

    const limited = await this.rateLimit.checkResend(fileId);
    if (limited) return { status: 'rate_limited' };

    const newDeliveryId = await withTransaction(this.pool, async (client) => {
      const delivery = await deliveries.insertQueued(client, {
        tenantId,
        fileId,
        requesterAddress: original.requester_address!,
        dmarc: original.dmarc,
        reason: `resend_of:${original.id}`,
      });
      await jobs.enqueue(client, {
        kind: 'delivery.fulfill',
        payload: {
          tenantId,
          fileId,
          deliveryId: delivery.id,
          requesterAddress: original.requester_address,
        },
        dedupeKey: `delivery.fulfill:resend:${delivery.id}`,
      });
      return delivery.id;
    });

    return { status: 'ok', deliveryId: newDeliveryId };
  }
}
