import type { Queryable } from '../pool.js';
import { jobs } from './jobs.js';

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
  /**
   * F-5 (`docs/security/red-team-report.md`, RT-52): a file created with an expiry
   * (`FilesService.createStaged` always sets one, from `DEFAULT_EXPIRY_DAYS`) schedules
   * its own `file.expire` job right here — architecture.md §7's revocation job was built
   * and unit-proven, but no production code path ever called `jobs.enqueue` for it, so
   * expiry never actually revoked anything on the default (raw-Zoho-link) distribution
   * path. `jobs.scheduleExpire` is a no-op when `expiresAt` is `null`.
   */
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
    await jobs.scheduleExpire(db, row.tenant_id, row.id, row.expires_at);
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

  /**
   * F-5 (RT-52): whenever `expiresAt` is part of the patch — set, changed, or cleared —
   * the `file.expire` schedule is updated to match, in the SAME call (not a separate step
   * a caller could forget). See `create`'s doc comment for why this matters.
   */
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
    const row = rows[0];
    if (row && 'expiresAt' in patch) {
      await jobs.scheduleExpire(db, tenantId, fileId, row.expires_at);
    }
    return row;
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

  /**
   * The `staging.purge` job's sweep (architecture.md §6): files whose staged blob is past
   * the retention window and above the attachment limit (a file at or below the limit
   * keeps its blob for life — it's the attachment source). System-wide, not tenant-scoped
   * by a request, but every returned row still carries its own `tenant_id` for the
   * caller's subsequent tenant-scoped writes.
   */
  async listStagingPurgeCandidates(
    db: Queryable,
    params: { attachLimitBytes: number; olderThanHours: number; limit?: number },
  ): Promise<FileRow[]> {
    const { rows } = await db.query<FileRow>(
      `SELECT * FROM files
       WHERE staging_blob_id IS NOT NULL
         AND size_bytes > $1
         AND status IN ('ready', 'failed', 'expired', 'deleted')
         AND created_at <= now() - ($2 || ' hours')::interval
       ORDER BY created_at
       LIMIT $3`,
      [params.attachLimitBytes, params.olderThanHours, params.limit ?? 100],
    );
    return rows;
  },

  /**
   * F-5's safety net: `ready` files past their own `expires_at` with no `file.expire` job
   * currently pending/processing. Under normal operation `create`/`updateSettings`
   * scheduling already covers every file, so this should almost always return nothing —
   * it exists to catch anything that scheduling missed (a file created before this fix
   * shipped, a lost race, manual data repair) rather than to be the primary mechanism.
   */
  async listExpiredWithoutScheduledJob(
    db: Queryable,
    params: { limit?: number } = {},
  ): Promise<FileRow[]> {
    const { rows } = await db.query<FileRow>(
      `SELECT f.* FROM files f
       WHERE f.status = 'ready' AND f.expires_at IS NOT NULL AND f.expires_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.dedupe_key = 'expire:' || f.id::text
             AND j.status IN ('pending', 'processing')
         )
       ORDER BY f.expires_at
       LIMIT $1`,
      [params.limit ?? 500],
    );
    return rows;
  },

  async clearStagingBlob(db: Queryable, tenantId: string, fileId: string): Promise<void> {
    await db.query('UPDATE files SET staging_blob_id = NULL WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      fileId,
    ]);
  },
};
