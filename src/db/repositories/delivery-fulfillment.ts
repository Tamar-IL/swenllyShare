import type { Queryable } from '../pool.js';
import type { DeliveryRow } from './deliveries.js';

/**
 * `delivery.fulfill`'s own tiny slice of `deliveries` access (F-4/F-6,
 * `docs/security/red-team-report.md`). Kept as a separate module rather than adding to
 * `src/db/repositories/deliveries.ts` because that file is owned by in-flight frontend
 * work this pass must not touch (see the backend-engineer's final report for the exact
 * reasoning) — everything here is additive and reads/writes the same `deliveries` table
 * `deliveries.ts` already owns, just through its own statements.
 *
 * `outcome = 'sending'` is a new value this pass adds to the `deliveries.outcome` CHECK
 * constraint (migration `0002_delivery_sending_state.sql`) but is deliberately NOT added
 * to `deliveries.ts`'s own `DeliveryOutcome` union — this module represents it as a plain
 * `string` on `DeliveryFulfillmentRow` instead, so that file's exported type is untouched.
 */
export interface DeliveryFulfillmentRow extends Omit<DeliveryRow, 'outcome'> {
  outcome: string;
}

export const deliveryFulfillment = {
  async getById(
    db: Queryable,
    tenantId: string,
    deliveryId: string,
  ): Promise<DeliveryFulfillmentRow | undefined> {
    const { rows } = await db.query<DeliveryFulfillmentRow>(
      'SELECT * FROM deliveries WHERE tenant_id = $1 AND id = $2',
      [tenantId, deliveryId],
    );
    return rows[0];
  },

  /**
   * F-6: the at-most-once transition, taken immediately before the external send call.
   * A compare-and-swap on `outcome = 'queued'` (never a plain UPDATE) — a row already
   * `sending`/`sent`/anything else fails this and returns `undefined`, which is exactly
   * the caller's signal that someone else's attempt got here first (or already finished)
   * and this attempt must not call the outbound port at all.
   */
  async markSending(
    db: Queryable,
    tenantId: string,
    deliveryId: string,
  ): Promise<DeliveryFulfillmentRow | undefined> {
    const { rows } = await db.query<DeliveryFulfillmentRow>(
      `UPDATE deliveries SET outcome = 'sending'
       WHERE tenant_id = $1 AND id = $2 AND outcome = 'queued'
       RETURNING *`,
      [tenantId, deliveryId],
    );
    return rows[0];
  },

  /**
   * `SharingEngine`'s pacing defer (architecture.md §5) fires before any external call —
   * nothing was disclosed, so it's safe to undo the `sending` CAS and let the rescheduled
   * job re-run the normal `queued` path (re-check gates, mark `sending` again, actually
   * attempt the share) instead of finding a `sending` row and wrongly finalizing it `sent`
   * without ever sending anything.
   */
  async revertSendingToQueued(db: Queryable, tenantId: string, deliveryId: string): Promise<void> {
    await db.query(
      `UPDATE deliveries SET outcome = 'queued' WHERE tenant_id = $1 AND id = $2 AND outcome = 'sending'`,
      [tenantId, deliveryId],
    );
  },
};
