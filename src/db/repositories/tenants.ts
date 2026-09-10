import type { Queryable } from '../pool.js';

export interface TenantRow {
  id: string;
  slug: string;
  email: string;
  // Fix pass 8 (docs/reviews/code-review.md, polish-pass finding 2, migration 0007):
  // persisted per-tenant storage-folder ids, nullable until `FilesService.publishFile`
  // resolves-and-persists them under an advisory lock the first time they're needed —
  // see that method's doc comment for the full "why".
  zoho_folder_id: string | null;
  drive_folder_id: string | null;
  created_at: Date;
}

export const tenants = {
  /** Case-folded lookup — "one email = one tenant" (architecture.md §3). */
  async findByEmail(db: Queryable, email: string): Promise<TenantRow | undefined> {
    const { rows } = await db.query<TenantRow>(
      'SELECT * FROM tenants WHERE lower(email) = lower($1)',
      [email],
    );
    return rows[0];
  },

  async findById(db: Queryable, tenantId: string): Promise<TenantRow | undefined> {
    const { rows } = await db.query<TenantRow>('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    return rows[0];
  },

  async findBySlug(db: Queryable, slug: string): Promise<TenantRow | undefined> {
    const { rows } = await db.query<TenantRow>('SELECT * FROM tenants WHERE slug = $1', [slug]);
    return rows[0];
  },

  /**
   * Creates a tenant, or returns the existing one for this email if a concurrent
   * sign-in already created it (first-successful-sign-in race, architecture.md §8).
   */
  async createIfNotExists(
    db: Queryable,
    params: { email: string; slug: string },
  ): Promise<TenantRow> {
    const { rows } = await db.query<TenantRow>(
      `INSERT INTO tenants (email, slug) VALUES ($1, $2)
       ON CONFLICT ((lower(email))) DO UPDATE SET email = tenants.email
       RETURNING *`,
      [params.email, params.slug],
    );
    const row = rows[0];
    if (!row) throw new Error('tenants.createIfNotExists: insert returned no row');
    return row;
  },

  /**
   * Fix pass 8 (code-review.md polish-pass finding 2): persists whichever of
   * `zohoFolderId`/`driveFolderId` is provided (either or both — an omitted field is
   * left untouched, never overwritten with NULL). Called by `FilesService.publishFile`
   * only while holding the `swenlly.tenant-folder` advisory lock on this tenant, so
   * concurrent resolvers never race to write two different ids.
   */
  async setFolderIds(
    db: Queryable,
    tenantId: string,
    patch: { zohoFolderId?: string | null; driveFolderId?: string | null },
  ): Promise<TenantRow | undefined> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.zohoFolderId !== undefined) {
      values.push(patch.zohoFolderId);
      sets.push(`zoho_folder_id = $${values.length}`);
    }
    if (patch.driveFolderId !== undefined) {
      values.push(patch.driveFolderId);
      sets.push(`drive_folder_id = $${values.length}`);
    }
    if (sets.length === 0) return tenants.findById(db, tenantId);
    values.push(tenantId);
    const { rows } = await db.query<TenantRow>(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    return rows[0];
  },
};
