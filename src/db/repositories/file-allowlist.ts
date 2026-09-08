import type { Queryable } from '../pool.js';

export interface FileAllowlistRow {
  id: string;
  tenant_id: string;
  file_id: string;
  pattern: string;
}

export const fileAllowlist = {
  async list(db: Queryable, tenantId: string, fileId: string): Promise<FileAllowlistRow[]> {
    const { rows } = await db.query<FileAllowlistRow>(
      'SELECT * FROM file_allowlist WHERE tenant_id = $1 AND file_id = $2 ORDER BY pattern',
      [tenantId, fileId],
    );
    return rows;
  },

  /** Idempotent: re-adding the same pattern for a file is a no-op, not an error. */
  async add(db: Queryable, tenantId: string, fileId: string, pattern: string): Promise<void> {
    await db.query(
      `INSERT INTO file_allowlist (tenant_id, file_id, pattern) VALUES ($1, $2, $3)
       ON CONFLICT (file_id, pattern) DO NOTHING`,
      [tenantId, fileId, pattern],
    );
  },

  async replaceAll(
    db: Queryable,
    tenantId: string,
    fileId: string,
    patterns: string[],
  ): Promise<void> {
    await db.query('DELETE FROM file_allowlist WHERE tenant_id = $1 AND file_id = $2', [
      tenantId,
      fileId,
    ]);
    for (const pattern of patterns) {
      await fileAllowlist.add(db, tenantId, fileId, pattern);
    }
  },

  async remove(db: Queryable, tenantId: string, fileId: string, pattern: string): Promise<void> {
    await db.query(
      'DELETE FROM file_allowlist WHERE tenant_id = $1 AND file_id = $2 AND pattern = $3',
      [tenantId, fileId, pattern],
    );
  },

  /**
   * Pipeline allowlist gate (architecture.md §4.8): does `address` match any pattern
   * for this file? Patterns are `user@host` (exact, case-insensitive) or `@domain`
   * (matches any local part at that domain). `address` and `domain` are both expected
   * pre-lowercased by the caller (the DMARC-verified From address).
   */
  async matches(
    db: Queryable,
    tenantId: string,
    fileId: string,
    address: string,
    domain: string,
  ): Promise<boolean> {
    const { rows } = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM file_allowlist
         WHERE tenant_id = $1 AND file_id = $2
           AND (lower(pattern) = lower($3) OR lower(pattern) = '@' || lower($4))
       ) AS exists`,
      [tenantId, fileId, address, domain],
    );
    return rows[0]?.exists ?? false;
  },
};
