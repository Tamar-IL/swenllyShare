import type { Queryable } from '../pool.js';

export type FileStatus = 'staged' | 'publishing' | 'ready' | 'expired' | 'deleted' | 'failed';
export type AllowlistMode = 'open' | 'allowlist';

export interface FileRow {
  id: string;
  tenant_id: string;
  display_name: string;
  original_name: string;
  size_bytes: string; // bigint comes back as string from node-postgres
  mime: string;
  zoho_resource_id: string | null;
  zoho_link_id: string | null;
  zoho_public_link: string | null;
  zoho_embed_token: string | null;
  drive_active_copy_id: string | null;
  request_token: string;
  public_slug: string;
  custom_message: string | null;
  expires_at: Date | null;
  allowlist_mode: AllowlistMode;
  staging_blob_id: string | null;
  status: FileStatus;
  created_at: Date;
}

export interface CreateFileParams {
  tenantId: string;
  displayName: string;
  originalName: string;
  sizeBytes: number | string;
  mime: string;
  requestToken: string;
  publicSlug: string;
  stagingBlobId?: string | null;
  customMessage?: string | null;
  expiresAt?: Date | null;
  allowlistMode?: AllowlistMode;
}

/** Fields `file.publish` (architecture.md §6) may set, one step at a time. Each column
 * is only ever written once per file (crash-safe: a retried step that finds its column
 * already set is a no-op at the domain layer; this repository just writes what it's
 * told). */
export interface PublishStepUpdate {
  zohoResourceId?: string;
  zohoLinkId?: string;
  zohoPublicLink?: string;
  zohoEmbedToken?: string;
  driveActiveCopyId?: string;
  status?: FileStatus;
}

export interface UpdateSettingsParams {
  displayName?: string;
  customMessage?: string | null;
  expiresAt?: Date | null;
  allowlistMode?: AllowlistMode;
}

const PUBLISH_STEP_COLUMNS: Record<keyof PublishStepUpdate, string> = {
  zohoResourceId: 'zoho_resource_id',
  zohoLinkId: 'zoho_link_id',
  zohoPublicLink: 'zoho_public_link',
  zohoEmbedToken: 'zoho_embed_token',
  driveActiveCopyId: 'drive_active_copy_id',
  status: 'status',
};

export const files = {
  async create(db: Queryable, params: CreateFileParams): Promise<FileRow> {
    const { rows } = await db.query<FileRow>(
      `INSERT INTO files (
         tenant_id, display_name, original_name, size_bytes, mime,
         request_token, public_slug, staging_blob_id, custom_message, expires_at,
         allowlist_mode
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 'open'))
       RETURNING *`,
      [
        params.tenantId,
        params.displayName,
        params.originalName,
        params.sizeBytes,
        params.mime,
        params.requestToken,
        params.publicSlug,
        params.stagingBlobId ?? null,
        params.customMessage ?? null,
        params.expiresAt ?? null,
        params.allowlistMode ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('files.create: insert returned no row');
    return row;
  },

  async findById(db: Queryable, tenantId: string, fileId: string): Promise<FileRow | undefined> {
    const { rows } = await db.query<FileRow>(
      'SELECT * FROM files WHERE tenant_id = $1 AND id = $2',
      [tenantId, fileId],
    );
    return rows[0];
  },

  async list(db: Queryable, tenantId: string, opts: { limit?: number } = {}): Promise<FileRow[]> {
    const { rows } = await db.query<FileRow>(
      'SELECT * FROM files WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
      [tenantId, opts.limit ?? 100],
    );
    return rows;
  },

  /**
   * Partial update for one or more `file.publish` step results (architecture.md §6).
   * Only the columns present in `patch` are written — safe to call repeatedly across
   * worker retries.
   */
  async setPublishStep(
    db: Queryable,
    tenantId: string,
    fileId: string,
    patch: PublishStepUpdate,
  ): Promise<FileRow | undefined> {
    const entries = Object.entries(patch) as [keyof PublishStepUpdate, string][];
    if (entries.length === 0) {
      return files.findById(db, tenantId, fileId);
    }
    const setClauses: string[] = [];
    const values: unknown[] = [tenantId, fileId];
    for (const [key, value] of entries) {
      values.push(value);
      setClauses.push(`${PUBLISH_STEP_COLUMNS[key]} = $${values.length}`);
    }
    const { rows } = await db.query<FileRow>(
      `UPDATE files SET ${setClauses.join(', ')}
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      values,
    );
    return rows[0];
  },

  async updateSettings(
    db: Queryable,
    tenantId: string,
    fileId: string,
    patch: UpdateSettingsParams,
  ): Promise<FileRow | undefined> {
    const columnByKey: Record<keyof UpdateSettingsParams, string> = {
      displayName: 'display_name',
      customMessage: 'custom_message',
      expiresAt: 'expires_at',
      allowlistMode: 'allowlist_mode',
    };
    const entries = Object.entries(patch) as [keyof UpdateSettingsParams, unknown][];
    if (entries.length === 0) {
      return files.findById(db, tenantId, fileId);
    }
    const setClauses: string[] = [];
    const values: unknown[] = [tenantId, fileId];
    for (const [key, value] of entries) {
      values.push(value);
      setClauses.push(`${columnByKey[key]} = $${values.length}`);
    }
    const { rows } = await db.query<FileRow>(
      `UPDATE files SET ${setClauses.join(', ')}
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      values,
    );
    return rows[0];
  },

  async markDeleted(db: Queryable, tenantId: string, fileId: string): Promise<FileRow | undefined> {
    const { rows } = await db.query<FileRow>(
      `UPDATE files SET status = 'deleted' WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, fileId],
    );
    return rows[0];
  },

  /**
   * Cross-tenant resolver #1 (architecture.md §3 invariant 1) — the ONLY way an inbound
   * webhook resolves an address to a file. Returns the file's own `tenant_id` so the
   * caller can assert it against the address's tenant slug (pipeline gate 4).
   */
  async resolveByRequestToken(db: Queryable, requestToken: string): Promise<FileRow | undefined> {
    const { rows } = await db.query<FileRow>('SELECT * FROM files WHERE request_token = $1', [
      requestToken,
    ]);
    return rows[0];
  },

  /** Cross-tenant resolver #2 — the branded page's slug lookup (`GET /s/:slug`). */
  async resolveBySlug(db: Queryable, publicSlug: string): Promise<FileRow | undefined> {
    const { rows } = await db.query<FileRow>('SELECT * FROM files WHERE public_slug = $1', [
      publicSlug,
    ]);
    return rows[0];
  },
};
