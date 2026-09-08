import type { Queryable } from '../pool.js';

export type DriveCopyStatus = 'provisioning' | 'active' | 'retired' | 'revoked';

export interface DriveCopyRow {
  id: string;
  tenant_id: string;
  file_id: string;
  intent_seq: number;
  drive_file_id: string | null;
  intent_key: string;
  share_count: number;
  last_share_at: Date | null;
  status: DriveCopyStatus;
  retire_reason: string | null;
  created_at: Date;
}

export const driveCopies = {
  /**
   * `provision(seq)` step 1 (architecture.md §5): reserve the `(tenant_id, file_id,
   * intent_seq)` slot. Returns the inserted row, or `undefined` if a concurrent caller
   * already won the race — the loser then reads the winner's row with `getBySeq`. This
   * is the idempotency half of the design; the advisory lock (pool.ts
   * `withAdvisoryLock`) is the mutual-exclusion half.
   */
  async insertIntent(
    db: Queryable,
    params: { tenantId: string; fileId: string; intentSeq: number; intentKey: string },
  ): Promise<DriveCopyRow | undefined> {
    const { rows } = await db.query<DriveCopyRow>(
      `INSERT INTO drive_copies (tenant_id, file_id, intent_seq, intent_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, file_id, intent_seq) DO NOTHING
       RETURNING *`,
      [params.tenantId, params.fileId, params.intentSeq, params.intentKey],
    );
    return rows[0];
  },

  async findById(
    db: Queryable,
    tenantId: string,
    fileId: string,
    copyId: string,
  ): Promise<DriveCopyRow | undefined> {
    const { rows } = await db.query<DriveCopyRow>(
      'SELECT * FROM drive_copies WHERE tenant_id = $1 AND file_id = $2 AND id = $3',
      [tenantId, fileId, copyId],
    );
    return rows[0];
  },

  async getBySeq(
    db: Queryable,
    tenantId: string,
    fileId: string,
    intentSeq: number,
  ): Promise<DriveCopyRow | undefined> {
    const { rows } = await db.query<DriveCopyRow>(
      'SELECT * FROM drive_copies WHERE tenant_id = $1 AND file_id = $2 AND intent_seq = $3',
      [tenantId, fileId, intentSeq],
    );
    return rows[0];
  },

  /** Crash recovery lookup (§5): survives a crash between `files.copy` and COMMIT. */
  async findByIntentKey(db: Queryable, intentKey: string): Promise<DriveCopyRow | undefined> {
    const { rows } = await db.query<DriveCopyRow>(
      'SELECT * FROM drive_copies WHERE intent_key = $1',
      [intentKey],
    );
    return rows[0];
  },

  /** The most recent active copy for `(tenant, file)` — `SharingEngine.share` phase 1. */
  async activeCopy(
    db: Queryable,
    tenantId: string,
    fileId: string,
  ): Promise<DriveCopyRow | undefined> {
    const { rows } = await db.query<DriveCopyRow>(
      `SELECT * FROM drive_copies
       WHERE tenant_id = $1 AND file_id = $2 AND status = 'active'
       ORDER BY intent_seq DESC LIMIT 1`,
      [tenantId, fileId],
    );
    return rows[0];
  },

  async listForFile(db: Queryable, tenantId: string, fileId: string): Promise<DriveCopyRow[]> {
    const { rows } = await db.query<DriveCopyRow>(
      'SELECT * FROM drive_copies WHERE tenant_id = $1 AND file_id = $2 ORDER BY intent_seq',
      [tenantId, fileId],
    );
    return rows;
  },

  /** `provision(seq)` step 3: record the Drive file id and mark the copy active. */
  async activate(
    db: Queryable,
    tenantId: string,
    fileId: string,
    copyId: string,
    driveFileId: string,
  ): Promise<DriveCopyRow | undefined> {
    const { rows } = await db.query<DriveCopyRow>(
      `UPDATE drive_copies
       SET drive_file_id = $4, status = 'active'
       WHERE tenant_id = $1 AND file_id = $2 AND id = $3
       RETURNING *`,
      [tenantId, fileId, copyId, driveFileId],
    );
    return rows[0];
  },

  async retire(
    db: Queryable,
    tenantId: string,
    fileId: string,
    copyId: string,
    reason: string,
  ): Promise<DriveCopyRow | undefined> {
    const { rows } = await db.query<DriveCopyRow>(
      `UPDATE drive_copies
       SET status = 'retired', retire_reason = $4
       WHERE tenant_id = $1 AND file_id = $2 AND id = $3
       RETURNING *`,
      [tenantId, fileId, copyId, reason],
    );
    return rows[0];
  },

  async revoke(
    db: Queryable,
    tenantId: string,
    fileId: string,
    copyId: string,
  ): Promise<DriveCopyRow | undefined> {
    const { rows } = await db.query<DriveCopyRow>(
      `UPDATE drive_copies SET status = 'revoked'
       WHERE tenant_id = $1 AND file_id = $2 AND id = $3
       RETURNING *`,
      [tenantId, fileId, copyId],
    );
    return rows[0];
  },

  /**
   * Reserve a share slot: `share_count += 1`, `last_share_at = now`. Called inside
   * the advisory-lock transaction, before the external `sharePermission` call
   * (architecture.md §5) — over-counting on a failed call is harmless, under-counting
   * is not, so the reservation always happens first.
   *
   * `now` is passed in explicitly (from the caller's injected `Clock`) rather than using
   * SQL `now()`: `SharingEngine`'s pacing check (architecture.md §5) compares
   * `last_share_at` against that same `Clock`, so both sides of the comparison must come
   * from one time source — otherwise a `FakeClock` frozen for a virtual-time test would
   * be compared against Postgres's real wall-clock `last_share_at`, and the two would
   * never agree (this was caught by the SharingEngine pacing test during development;
   * see docs/lessons.md).
   */
  async reserveShare(
    db: Queryable,
    tenantId: string,
    fileId: string,
    copyId: string,
    now: Date,
  ): Promise<DriveCopyRow | undefined> {
    const { rows } = await db.query<DriveCopyRow>(
      `UPDATE drive_copies
       SET share_count = share_count + 1, last_share_at = $4
       WHERE tenant_id = $1 AND file_id = $2 AND id = $3
       RETURNING *`,
      [tenantId, fileId, copyId, now],
    );
    return rows[0];
  },
};
