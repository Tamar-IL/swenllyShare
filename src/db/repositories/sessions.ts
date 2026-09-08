import type { Queryable } from '../pool.js';

export interface SessionRow {
  id: string;
  tenant_id: string;
  expires_at: Date;
  last_seen_at: Date;
  user_agent_hash: string | null;
  created_at: Date;
}

const TOUCH_MIN_INTERVAL_MS = 60 * 60 * 1000; // sliding refresh at most hourly (§8)

export const sessions = {
  async create(
    db: Queryable,
    params: {
      id: string;
      tenantId: string;
      expiresAt: Date;
      userAgentHash?: string | null;
    },
  ): Promise<SessionRow> {
    const { rows } = await db.query<SessionRow>(
      `INSERT INTO sessions (id, tenant_id, expires_at, user_agent_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [params.id, params.tenantId, params.expiresAt, params.userAgentHash ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('sessions.create: insert returned no row');
    return row;
  },

  async findById(db: Queryable, sessionId: string): Promise<SessionRow | undefined> {
    const { rows } = await db.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [
      sessionId,
    ]);
    return rows[0];
  },

  /**
   * Sliding 30-day expiry, refreshed at most once per hour (architecture.md §8): only
   * writes when the session hasn't been touched in the last hour, so a busy session
   * doesn't generate a write on every request.
   */
  async touch(
    db: Queryable,
    sessionId: string,
    params: { newExpiresAt: Date },
  ): Promise<SessionRow | undefined> {
    const { rows } = await db.query<SessionRow>(
      `UPDATE sessions
       SET last_seen_at = now(), expires_at = $2
       WHERE id = $1 AND last_seen_at < now() - ($3 || ' milliseconds')::interval
       RETURNING *`,
      [sessionId, params.newExpiresAt, TOUCH_MIN_INTERVAL_MS],
    );
    return rows[0];
  },

  async destroy(db: Queryable, sessionId: string): Promise<void> {
    await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  },

  async deleteExpired(db: Queryable): Promise<number> {
    const result = await db.query('DELETE FROM sessions WHERE expires_at <= now()');
    return result.rowCount ?? 0;
  },
};
