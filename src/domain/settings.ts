import type pg from 'pg';
import { files, type FileRow, type AllowlistMode } from '../db/repositories/files.js';
import { fileAllowlist } from '../db/repositories/file-allowlist.js';
import { withTransaction } from '../db/pool.js';
import type { Clock } from '../ports/clock.js';
import { AppError, ErrorCode } from '../lib/errors.js';

export type ExpiryMode = 'none' | 'days' | 'custom';

export interface SettingsConfig {
  DEFAULT_EXPIRY_DAYS: number;
}

export interface UpdateSettingsInput {
  displayName?: string;
  customMessage?: string | null;
  expiryMode?: ExpiryMode;
  expiryDays?: number;
  expiresAt?: Date;
  allowlistMode?: AllowlistMode;
  allowlist?: string[];
}

// user@host or @domain, both ASCII-domain-only (architecture.md §0). Case-insensitive.
const USER_AT_HOST_RE =
  /^[^\s@]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const AT_DOMAIN_RE = /^@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

function validatePattern(pattern: string): string {
  const trimmed = pattern.trim().toLowerCase();
  if (!USER_AT_HOST_RE.test(trimmed) && !AT_DOMAIN_RE.test(trimmed)) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      400,
      `invalid allowlist pattern: ${JSON.stringify(pattern)} (expected "user@host" or "@domain")`,
    );
  }
  return trimmed;
}

/**
 * Per-file settings: display name, custom message, expiry (architecture.md §7), and the
 * allowlist opt-in (architecture.md §0 — the one deliberate stricter-than-PRD control).
 */
export class SettingsService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: SettingsConfig,
  ) {}

  /** Pure translation of an expiry-mode form input into the `expires_at` column value. */
  resolveExpiry(
    mode: ExpiryMode,
    opts: { days?: number; expiresAt?: Date },
    clock: Clock,
  ): Date | null {
    switch (mode) {
      case 'none':
        return null;
      case 'days': {
        const days = opts.days ?? this.config.DEFAULT_EXPIRY_DAYS;
        if (!Number.isFinite(days) || days <= 0) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            400,
            'expiryDays must be a positive number',
          );
        }
        return new Date(clock.now().getTime() + days * 24 * 60 * 60 * 1000);
      }
      case 'custom': {
        if (!opts.expiresAt || Number.isNaN(opts.expiresAt.getTime())) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            400,
            'expiresAt is required for custom expiry',
          );
        }
        return opts.expiresAt;
      }
      default:
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, `invalid expiry mode: ${String(mode)}`);
    }
  }

  /**
   * Bug 3 (`docs/qa/qa-report-sender-app.md`): a settings save is one submission and must
   * be all-or-nothing. Two things were needed, not one: (1) validate *everything* —
   * including every allowlist pattern — before any write is issued, so a bad line is
   * rejected before `files.updateSettings` ever runs; (2) the two writes that do land
   * (`files.updateSettings` and `fileAllowlist.replaceAll`) must commit together in one
   * transaction, so a later failure (e.g. the file having vanished between validation and
   * write) can't leave one committed and the other not.
   */
  async updateSettings(
    tenantId: string,
    fileId: string,
    input: UpdateSettingsInput,
    clock: Clock,
  ): Promise<FileRow> {
    const patch: Parameters<typeof files.updateSettings>[3] = {};
    if (input.displayName !== undefined) {
      const trimmed = input.displayName.trim();
      if (trimmed === '') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'displayName cannot be empty');
      }
      patch.displayName = trimmed;
    }
    if (input.customMessage !== undefined) patch.customMessage = input.customMessage;
    if (input.expiryMode !== undefined) {
      patch.expiresAt = this.resolveExpiry(
        input.expiryMode,
        { days: input.expiryDays, expiresAt: input.expiresAt },
        clock,
      );
    }
    if (input.allowlistMode !== undefined) patch.allowlistMode = input.allowlistMode;

    // Validate the whole submission up front — nothing below this point can throw for a
    // reason the caller could have fixed by re-submitting, only NOT_FOUND (a race, not a
    // validation failure) can still occur inside the transaction.
    const patterns =
      input.allowlist !== undefined
        ? input.allowlist
            .map((p) => p.trim())
            .filter((p) => p !== '')
            .map(validatePattern)
        : undefined;

    return withTransaction(this.pool, async (client) => {
      const updated = await files.updateSettings(client, tenantId, fileId, patch);
      if (!updated) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'file not found');
      }

      if (patterns !== undefined) {
        await fileAllowlist.replaceAll(client, tenantId, fileId, patterns);
      }

      return updated;
    });
  }

  async getAllowlist(tenantId: string, fileId: string): Promise<string[]> {
    const rows = await fileAllowlist.list(this.pool, tenantId, fileId);
    return rows.map((r) => r.pattern);
  }
}
