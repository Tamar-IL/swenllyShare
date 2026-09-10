import { withTransaction, type Pool } from '../db/pool.js';
import { files, type FileRow, type AllowlistMode } from '../db/repositories/files.js';
import { fileAllowlist } from '../db/repositories/file-allowlist.js';
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

// Findings #5/#6 (docs/security/appsec-review.md): `displayName` becomes an outbound
// email subject and attachment filename, `customMessage` becomes the outbound body,
// both verbatim (`reply-composer.ts`) — neither may carry CR/LF/control characters (which
// could inject extra header lines or corrupt rendering), and neither may grow unbounded.
const DISPLAY_NAME_MAX_LENGTH = 255;
const CUSTOM_MESSAGE_MAX_LENGTH = 5000;

function stripControlChars(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

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
    private readonly pool: Pool,
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
      const trimmed = stripControlChars(input.displayName).trim();
      if (trimmed === '') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'displayName cannot be empty');
      }
      if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          `displayName must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
        );
      }
      patch.displayName = trimmed;
    }
    if (input.customMessage !== undefined) {
      const cleaned =
        input.customMessage === null ? null : stripControlChars(input.customMessage).trim();
      if (cleaned !== null && cleaned.length > CUSTOM_MESSAGE_MAX_LENGTH) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          `customMessage must be at most ${CUSTOM_MESSAGE_MAX_LENGTH} characters`,
        );
      }
      patch.customMessage = cleaned;
    }
    if (input.expiryMode !== undefined) {
      patch.expiresAt = this.resolveExpiry(
        input.expiryMode,
        { days: input.expiryDays, expiresAt: input.expiresAt },
        clock,
      );
      // Fix pass 7 (critic-report.md Minor): persist the FORM's own choice alongside the
      // derived `expires_at` timestamp (migration 0006) — `resolveExpiry` above already
      // validated it (throws before this point on a bad `days`/missing `expiresAt`), so
      // this mirrors exactly what was just computed, never a second, divergent decision.
      patch.expiryMode = input.expiryMode;
      patch.expiryDays =
        input.expiryMode === 'days' ? (input.expiryDays ?? this.config.DEFAULT_EXPIRY_DAYS) : null;
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
