import type { Queryable } from '../pool.js';

export type DmarcResult = 'pass' | 'fail' | 'none' | 'unknown';

export interface InboundMessageRow {
  id: string;
  provider_message_id: string;
  signature_token: string;
  recipient_raw: string;
  tenant_id: string | null;
  file_id: string | null;
  from_address: string | null;
  from_domain: string | null;
  dmarc: DmarcResult | null;
  spf: string | null;
  dkim: string | null;
  quarantined: boolean;
  reason: string | null;
  raw_payload: unknown;
  purge_after: Date | null;
  created_at: Date;
}

export interface InsertInboundMessageParams {
  providerMessageId: string;
  signatureToken: string;
  recipientRaw: string;
  tenantId?: string | null;
  fileId?: string | null;
  fromAddress?: string | null;
  fromDomain?: string | null;
  dmarc?: DmarcResult | null;
  spf?: string | null;
  dkim?: string | null;
  rawPayload?: unknown;
  purgeAfter?: Date | null;
}

export type InsertOrDuplicateResult =
  { duplicate: false; row: InboundMessageRow } | { duplicate: true };

export const inboundMessages = {
  /**
   * The replay gate (architecture.md §4.2): `signature_token` is unique, so a replayed
   * webhook delivery hits `ON CONFLICT ... DO NOTHING` and this returns
   * `{duplicate: true}` — no exception, so the caller's enclosing transaction (if any)
   * is never aborted by the conflict the way a raw unique-violation would abort it.
   *
   * F-11 (`docs/security/red-team-report.md`, RT-22): `provider_message_id` is ALSO
   * unique (`inbound_messages_provider_message_id_unique_idx`, migration 0001) — the same
   * RFC 5322 message re-injected under a fresh Mailgun `signature_token` (two matching
   * routes, a forwarding/bounce loop, a provider-side re-delivery) must be deduped exactly
   * like a `signature_token` replay, not treated as a brand-new message. `ON CONFLICT DO
   * NOTHING` with NO explicit target catches a violation of EITHER unique index — the
   * previous version named `signature_token` as the only arbiter, so a
   * `provider_message_id` collision fell through as an uncaught unique-violation
   * exception instead of the graceful `{duplicate: true}` this method promises.
   */
  async insertOrDuplicate(
    db: Queryable,
    params: InsertInboundMessageParams,
  ): Promise<InsertOrDuplicateResult> {
    const { rows } = await db.query<InboundMessageRow>(
      `INSERT INTO inbound_messages (
         provider_message_id, signature_token, recipient_raw, tenant_id, file_id,
         from_address, from_domain, dmarc, spf, dkim, raw_payload, purge_after
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        params.providerMessageId,
        params.signatureToken,
        params.recipientRaw,
        params.tenantId ?? null,
        params.fileId ?? null,
        params.fromAddress ?? null,
        params.fromDomain ?? null,
        params.dmarc ?? null,
        params.spf ?? null,
        params.dkim ?? null,
        params.rawPayload === undefined ? null : JSON.stringify(params.rawPayload),
        params.purgeAfter ?? null,
      ],
    );
    const row = rows[0];
    if (!row) return { duplicate: true };
    return { duplicate: false, row };
  },

  async findBySignatureToken(
    db: Queryable,
    signatureToken: string,
  ): Promise<InboundMessageRow | undefined> {
    const { rows } = await db.query<InboundMessageRow>(
      'SELECT * FROM inbound_messages WHERE signature_token = $1',
      [signatureToken],
    );
    return rows[0];
  },

  async markQuarantined(
    db: Queryable,
    id: string,
    reason: string,
  ): Promise<InboundMessageRow | undefined> {
    const { rows } = await db.query<InboundMessageRow>(
      `UPDATE inbound_messages SET quarantined = true, reason = $2 WHERE id = $1 RETURNING *`,
      [id, reason],
    );
    return rows[0];
  },

  async attachResolution(
    db: Queryable,
    id: string,
    params: { tenantId: string; fileId: string },
  ): Promise<InboundMessageRow | undefined> {
    const { rows } = await db.query<InboundMessageRow>(
      `UPDATE inbound_messages SET tenant_id = $2, file_id = $3 WHERE id = $1 RETURNING *`,
      [id, params.tenantId, params.fileId],
    );
    return rows[0];
  },

  /** `inbound.purge` job (architecture.md §10): null the raw payload past retention,
   * leaving the row and its audit fields intact. */
  async purgeRawPayloadsPastRetention(db: Queryable): Promise<number> {
    const result = await db.query(
      `UPDATE inbound_messages SET raw_payload = NULL
       WHERE raw_payload IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= now()`,
    );
    return result.rowCount ?? 0;
  },
};
