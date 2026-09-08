import { createHash } from 'node:crypto';
import type pg from 'pg';
import { magicLinks } from '../db/repositories/magic-links.js';
import { sessions, type SessionRow } from '../db/repositories/sessions.js';
import { tenants, type TenantRow } from '../db/repositories/tenants.js';
import type { Clock } from '../ports/clock.js';
import type { TokenGen } from '../ports/token-gen.js';
import type { OutboundMailPort } from '../ports/outbound-mail.js';
import { AppError, ErrorCode } from '../lib/errors.js';

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAGIC_LINK_TOKEN_BITS = 130;
const SESSION_ID_BITS = 128;
const TENANT_SLUG_BITS = 40; // 8 base32 chars — well within the 6-32 char inbound-address slug range.

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Magic-link sign-in and session lifecycle (architecture.md §8). One email = one tenant,
 * created lazily on first successful sign-in — `requestMagicLink` never discloses whether
 * an account already exists (always the same response), and the plaintext token is never
 * persisted, only its sha256 hash.
 */
export class AuthService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ports: { tokenGen: TokenGen; clock: Clock; outboundMail: OutboundMailPort },
    private readonly config: { PUBLIC_BASE_URL: string },
  ) {}

  /**
   * Mints a magic-link token, stores its hash, and emails the plaintext link. Always
   * succeeds from the caller's point of view regardless of whether `email` has ever
   * signed in before — enumeration-proof by construction (architecture.md §8).
   */
  async requestMagicLink(email: string, requestedIp?: string | null): Promise<void> {
    const plaintext = this.ports.tokenGen.opaque(MAGIC_LINK_TOKEN_BITS);
    const tokenHash = sha256Hex(plaintext);
    const expiresAt = new Date(this.ports.clock.now().getTime() + MAGIC_LINK_TTL_MS);
    await magicLinks.create(this.pool, {
      tokenHash,
      email: email.toLowerCase(),
      expiresAt,
      requestedIp,
    });

    const link = `${this.config.PUBLIC_BASE_URL}/auth/callback?token=${encodeURIComponent(plaintext)}`;
    await this.ports.outboundMail.send({
      to: email,
      subject: 'קישור כניסה ל-Swenlly Share',
      text: [
        'שלום,',
        '',
        'להתחברות לחשבון שלך, לחץ/י על הקישור הבא (בתוקף ל-15 דקות):',
        link,
        '',
        'אם לא ביקשת קישור זה, ניתן להתעלם מהודעה זו.',
      ].join('\n'),
    });
  }

  /**
   * Consumes a magic-link token and completes sign-in: creates the tenant on first
   * success, opens a session, and returns it. Throws `AppError(INVALID_TOKEN)` for any
   * failure reason (unknown, expired, already consumed) — deliberately undifferentiated,
   * matching the repository's `consume()` (architecture.md §8: "reject if consumed or
   * expired", rendered as one generic error, never distinguishing why).
   */
  async completeSignIn(
    plaintextToken: string,
  ): Promise<{ tenant: TenantRow; session: SessionRow }> {
    const tokenHash = sha256Hex(plaintextToken);
    const consumed = await magicLinks.consume(this.pool, tokenHash);
    if (!consumed) {
      throw new AppError(
        ErrorCode.INVALID_TOKEN,
        400,
        'This sign-in link is invalid or has expired.',
      );
    }

    const slug = this.ports.tokenGen.opaque(TENANT_SLUG_BITS);
    const tenant = await tenants.createIfNotExists(this.pool, { email: consumed.email, slug });
    const session = await this.createSession(tenant.id);
    return { tenant, session };
  }

  async createSession(tenantId: string, userAgentHash?: string | null): Promise<SessionRow> {
    const id = this.ports.tokenGen.opaque(SESSION_ID_BITS);
    const expiresAt = new Date(this.ports.clock.now().getTime() + SESSION_TTL_MS);
    return sessions.create(this.pool, { id, tenantId, expiresAt, userAgentHash });
  }

  /** Resolves a session cookie value to its tenant, or `undefined` if missing/expired. */
  async resolveSession(sessionId: string): Promise<{ tenantId: string } | undefined> {
    const row = await sessions.findById(this.pool, sessionId);
    if (!row) return undefined;
    if (row.expires_at.getTime() <= this.ports.clock.now().getTime()) return undefined;
    return { tenantId: row.tenant_id };
  }

  /** Sliding refresh — a no-op (returns `undefined`) unless the session hasn't been
   * touched in the last hour (enforced by the repository, architecture.md §8). The
   * caller (the auth HTTP plugin) uses a defined return to know it must also reissue the
   * `Set-Cookie` with the new expiry. */
  async touchSession(sessionId: string): Promise<SessionRow | undefined> {
    const newExpiresAt = new Date(this.ports.clock.now().getTime() + SESSION_TTL_MS);
    return sessions.touch(this.pool, sessionId, { newExpiresAt });
  }

  async destroySession(sessionId: string): Promise<void> {
    await sessions.destroy(this.pool, sessionId);
  }
}
