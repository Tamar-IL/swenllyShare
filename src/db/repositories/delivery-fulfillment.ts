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
 * `outcome = 'sending' | 'dispatching'` are values this pass adds to the
 * `deliveries.outcome` CHECK constraint (migrations `0002_delivery_sending_state.sql`,
 * `0003_delivery_dispatching_state.sql`) but are deliberately NOT added to
 * `deliveries.ts`'s own `DeliveryOutcome` union — this module represents outcome as a
 * plain `string` on `DeliveryFulfillmentRow` instead, so that file's exported type is
 * untouched.
 *
 * Code review finding 2 (docs/reviews/code-review.md, fix pass 4): a SINGLE `sending`
 * marker conflated two very different crash windows — "before any local work" (blob
 * open/read, `SharingEngine`'s reserve phase; nothing external has been attempted, so a
 * retry must redo everything) and "after the actual outbound call was issued" (the
 * provider may well have it; a retry must NOT call it again). Splitting `sending` into
 * two states, in the order `queued -> sending -> dispatching -> sent`, makes each retry
 * rule exact instead of a guess: `sending` alone is always safe to retry from scratch;
 * only `dispatching` is finalized `sent` without resending.
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
   * Step 1 of the two-step CAS, taken before ANY local work (blob open/read,
   * `SharingEngine`'s reserve phase) — never mind the external send. A row already past
   * `queued` fails this and returns `undefined`, the caller's signal that someone/
   * something else already owns this delivery (another attempt in flight, or it's
   * already finished) and this attempt must go no further.
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
   * Step 2 of the two-step CAS, taken immediately before the actual outbound call
   * (`outboundMail.send` for an attachment, `SharingEngine.share` — which itself calls
   * `sharePermission` — for a Drive share). Everything between `markSending` and this
   * call (blob stat/open/read, `SharingEngine`'s advisory-locked reserve transaction) is
   * local work only; only a crash AFTER this CAS succeeds means the external call may
   * actually have gone out, which is exactly what makes a `dispatching` row safe to
   * finalize on retry without resending, and a bare `sending` row NOT safe to finalize —
   * it must be retried from scratch instead (`handleDeliveryFulfill`'s `sending` branch).
   */
  async markDispatching(
    db: Queryable,
    tenantId: string,
    deliveryId: string,
  ): Promise<DeliveryFulfillmentRow | undefined> {
    const { rows } = await db.query<DeliveryFulfillmentRow>(
      `UPDATE deliveries SET outcome = 'dispatching'
       WHERE tenant_id = $1 AND id = $2 AND outcome = 'sending'
       RETURNING *`,
      [tenantId, deliveryId],
    );
    return rows[0];
  },

  /**
   * `SharingEngine`'s pacing defer (architecture.md §5) can fire right after
   * `markDispatching` but before `sharePermission` is ever called — nothing was
   * disclosed, so it's safe to undo the CAS and let the rescheduled job re-run the
   * normal `queued` path (re-check gates, mark `sending` then `dispatching` again,
   * actually attempt the share) instead of leaving a `dispatching` row that the next
   * attempt would wrongly finalize `sent` without ever sending anything.
   */
  async revertDispatchingToQueued(
    db: Queryable,
    tenantId: string,
    deliveryId: string,
  ): Promise<void> {
    await db.query(
      `UPDATE deliveries SET outcome = 'queued'
       WHERE tenant_id = $1 AND id = $2 AND outcome = 'dispatching'`,
      [tenantId, deliveryId],
    );
  },
};
