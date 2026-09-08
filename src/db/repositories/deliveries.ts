import type { Queryable } from '../pool.js';

export type DeliveryMechanism = 'attachment' | 'drive_share';
export type DeliveryOutcome =
  | 'queued'
  | 'sent'
  // Fix pass 5, F-A: a genuinely unresolvable send — an `AmbiguousSendError` from the
  // outbound call, or a bare process crash on a `dispatching` row with no recorded
  // definite error. Never `sent` (the requester may not have received the file), never
  // silently `failed` (it may well have gone out) — recorded honestly as its own terminal
  // state (src/jobs/handlers/delivery-fulfill.ts).
  | 'unconfirmed'
  | 'failed'
  | 'quarantined'
  | 'rate_limited'
  | 'expired'
  | 'not_allowlisted';

export interface DeliveryRow {
  id: string;
  tenant_id: string;
  file_id: string;
  requester_address: string;
  mechanism: DeliveryMechanism | null;
  dmarc: string | null;
  drive_copy_id: string | null;
  outcome: DeliveryOutcome;
  reason: string | null;
  inbound_message_id: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export const deliveries = {
  /**
   * Append-then-complete (architecture.md §3 invariant 4): this row is written in the
   * same transaction as the outbox job (pipeline gate 10), before any external send
   * happens, so a crash mid-delivery is visible as a stuck `queued` row, never silently
   * lost.
   */
  async insertQueued(
    db: Queryable,
    params: {
      tenantId: string;
      fileId: string;
      requesterAddress: string;
      dmarc?: string | null;
      inboundMessageId?: string | null;
    },
  ): Promise<DeliveryRow> {
    const { rows } = await db.query<DeliveryRow>(
      `INSERT INTO deliveries (tenant_id, file_id, requester_address, dmarc, inbound_message_id, outcome)
       VALUES ($1, $2, $3, $4, $5, 'queued')
       RETURNING *`,
      [
        params.tenantId,
        params.fileId,
        params.requesterAddress,
        params.dmarc ?? null,
        params.inboundMessageId ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('deliveries.insertQueued: insert returned no row');
    return row;
  },

  /**
   * Records any terminal outcome that never reached a queued send (quarantined,
   * rate_limited, expired, not_allowlisted, or an immediate failed) — the pipeline
   * gates write these directly without ever going through `insertQueued`.
   */
  async insertTerminal(
    db: Queryable,
    params: {
      tenantId: string;
      fileId: string;
      requesterAddress: string;
      outcome: Exclude<DeliveryOutcome, 'queued' | 'sent'>;
      reason?: string | null;
      dmarc?: string | null;
      inboundMessageId?: string | null;
    },
  ): Promise<DeliveryRow> {
    const { rows } = await db.query<DeliveryRow>(
      `INSERT INTO deliveries (tenant_id, file_id, requester_address, dmarc, inbound_message_id, outcome, reason, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       RETURNING *`,
      [
        params.tenantId,
        params.fileId,
        params.requesterAddress,
        params.dmarc ?? null,
        params.inboundMessageId ?? null,
        params.outcome,
        params.reason ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('deliveries.insertTerminal: insert returned no row');
    return row;
  },

  /** `delivery.fulfill` resolving a queued row to its final outcome. */
  async complete(
    db: Queryable,
    tenantId: string,
    deliveryId: string,
    params: {
      outcome: DeliveryOutcome;
      mechanism?: DeliveryMechanism | null;
      driveCopyId?: string | null;
      reason?: string | null;
    },
  ): Promise<DeliveryRow | undefined> {
    const { rows } = await db.query<DeliveryRow>(
      `UPDATE deliveries
       SET outcome = $3, mechanism = COALESCE($4, mechanism),
           drive_copy_id = COALESCE($5, drive_copy_id), reason = COALESCE($6, reason),
           completed_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        tenantId,
        deliveryId,
        params.outcome,
        params.mechanism ?? null,
        params.driveCopyId ?? null,
        params.reason ?? null,
      ],
    );
    return rows[0];
  },

  /** `GET /api/files/:id/deliveries` — required index order `(tenant_id, file_id,
   * created_at desc)`.
   *
   * Bug 1 (`docs/qa/qa-report-sender-app.md`): `since` alone is NOT a safe cursor on its
   * own. It round-trips through `Date#toISOString()` (millisecond precision) on both ends
   * while `created_at` is Postgres `timestamptz` (microsecond precision), so a plain
   * `created_at > since` stays true for the very row `since` was derived from forever —
   * every poll re-matches and re-appends its own anchor row. The fix is a `(created_at,
   * id)` keyset: pass `sinceId` (the anchor row's own id) alongside `since` and this
   * floors the range on the (possibly-truncated) timestamp for `since >= $3` while
   * excluding the exact anchor row by id, which is exact regardless of any timestamp
   * precision loss. Callers that only have a bare timestamp (no id) fall back to the
   * original strict `>` comparison — no worse than before, just not the robust path.
   */
  async listForFile(
    db: Queryable,
    tenantId: string,
    fileId: string,
    opts: { since?: Date; sinceId?: string; limit?: number } = {},
  ): Promise<DeliveryRow[]> {
    if (opts.since) {
      const { rows } = await db.query<DeliveryRow>(
        `SELECT * FROM deliveries
         WHERE tenant_id = $1 AND file_id = $2
           AND (
             ($4::uuid IS NULL AND created_at > $3)
             OR ($4::uuid IS NOT NULL AND created_at >= $3 AND id <> $4)
           )
         ORDER BY created_at DESC LIMIT $5`,
        [tenantId, fileId, opts.since, opts.sinceId ?? null, opts.limit ?? 100],
      );
      return rows;
    }
    const { rows } = await db.query<DeliveryRow>(
      `SELECT * FROM deliveries
       WHERE tenant_id = $1 AND file_id = $2
       ORDER BY created_at DESC LIMIT $3`,
      [tenantId, fileId, opts.limit ?? 100],
    );
    return rows;
  },

  async countForFile(db: Queryable, tenantId: string, fileId: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM deliveries WHERE tenant_id = $1 AND file_id = $2',
      [tenantId, fileId],
    );
    return Number(rows[0]?.count ?? '0');
  },

  /**
   * Frontend-engineer addition (Lane C): one grouped query for the file list's "נשלח
   * ל-N" mini delivery count (UX brief §1.2), instead of one `countForFile` call per row
   * — the list can hold up to 100 files (`files.list`'s default limit), so N+1 queries
   * would be the wrong shape for a page render.
   */
  /**
   * Fix pass 6 (critic N-2): deliveries that finalized `unconfirmed` — "we may or may
   * not have sent this" — are an operator signal, not a dead end. Cross-tenant on purpose:
   * this is an ops counter for `/readyz`, not a tenant view; it exposes a number only.
   */
  async countUnconfirmed(db: Queryable): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM deliveries WHERE outcome = 'unconfirmed'",
    );
    return Number(rows[0]?.count ?? '0');
  },

  async countsSentByTenant(db: Queryable, tenantId: string): Promise<Map<string, number>> {
    const { rows } = await db.query<{ file_id: string; count: string }>(
      `SELECT file_id, count(*)::text AS count FROM deliveries
       WHERE tenant_id = $1 AND outcome = 'sent'
       GROUP BY file_id`,
      [tenantId],
    );
    return new Map(rows.map((r) => [r.file_id, Number(r.count)]));
  },
};
