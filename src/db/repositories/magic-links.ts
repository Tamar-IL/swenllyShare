import type { Queryable } from '../pool.js';

export interface MagicLinkTokenRow {
  token_hash: string;
  email: string;
  expires_at: Date;
  consumed_at: Date | null;
  requested_ip: string | null;
  created_at: Date;
}

export const magicLinks = {
  async create(
    db: Queryable,
    params: { tokenHash: string; email: string; expiresAt: Date; requestedIp?: string | null },
  ): Promise<MagicLinkTokenRow> {
    const { rows } = await db.query<MagicLinkTokenRow>(
      `INSERT INTO magic_link_tokens (token_hash, email, expires_at, requested_ip)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [params.tokenHash, params.email, params.expiresAt, params.requestedIp ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('magicLinks.create: insert returned no row');
    return row;
  },

  async findByHash(db: Queryable, tokenHash: string): Promise<MagicLinkTokenRow | undefined> {
    const { rows } = await db.query<MagicLinkTokenRow>(
      'SELECT * FROM magic_link_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    return rows[0];
  },

  /**
   * Atomically consumes a token: succeeds only once, only if unexpired. Returns
   * undefined for missing/expired/already-consumed — the caller renders the same
   * generic error for all three (no enumeration, architecture.md §8).
   */
  async consume(db: Queryable, tokenHash: string): Promise<MagicLinkTokenRow | undefined> {
    const { rows } = await db.query<MagicLinkTokenRow>(
      `UPDATE magic_link_tokens
       SET consumed_at = now()
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING *`,
      [tokenHash],
    );
    return rows[0];
  },

  async countRequestedSince(db: Queryable, email: string, since: Date): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM magic_link_tokens WHERE email = $1 AND created_at >= $2',
      [email, since],
    );
    return Number(rows[0]?.count ?? '0');
  },
};
