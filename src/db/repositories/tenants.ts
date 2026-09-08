import type { Queryable } from '../pool.js';

export interface TenantRow {
  id: string;
  slug: string;
  email: string;
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
};
