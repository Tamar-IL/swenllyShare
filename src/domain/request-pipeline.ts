import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { deliveries } from '../db/repositories/deliveries.js';
import { fileAllowlist } from '../db/repositories/file-allowlist.js';
import { files } from '../db/repositories/files.js';
import { inboundMessages, type InboundMessageRow } from '../db/repositories/inbound-messages.js';
import { jobs } from '../db/repositories/jobs.js';
import { rateLimits } from '../db/repositories/rate-limits.js';
import { tenants } from '../db/repositories/tenants.js';
import { parseRequestAddress } from '../lib/addressing.js';
import { addressDomain } from '../lib/email-address.js';
import type { Clock } from '../ports/clock.js';
import type { InboundMailPort } from '../ports/inbound-mail.js';
import type { RateLimitService } from './rate-limit.js';

export interface PipelineOutcome {
  status: 200 | 401 | 406;
  /** Present only on a 200 that reached the end of the pipeline and enqueued a delivery —
   * convenient for tests; never used to decide the HTTP response. */
  deliveryId?: string;
}

export interface RequestPipelineConfig {
  INBOUND_DOMAIN: string;
  RAW_PAYLOAD_RETENTION_DAYS: number;
  /** F-1 kill switch: when false, every otherwise-valid webhook is quarantined with
   * reason `inbound_disabled` instead of ever reaching the DMARC gate. */
  INBOUND_REQUESTS_ENABLED: boolean;
  /** F-7: caps how many pre-authentication quarantine writes one resolved request-token
   * can cause per hour. */
  QUARANTINE_PER_TOKEN_PER_HOUR: number;
}

const QUARANTINE_CAP_WINDOW_MINUTES = 60;

/**
 * The inbound request pipeline (architecture.md §4) — gates run in this exact order, the
 * first failure writes an audit row (where one applies) and stops. The requester is never
 * told why anything failed (UX brief §3): every non-401/406 outcome is HTTP 200.
 */
export class RequestPipeline {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ports: { inboundMail: InboundMailPort; clock: Clock },
    private readonly rateLimit: RateLimitService,
    private readonly config: RequestPipelineConfig,
  ) {}

  async handleWebhook(payload: Record<string, unknown>): Promise<PipelineOutcome> {
    // Gate 1: signature verify. Nothing is written on failure.
    const timestamp = String(payload.timestamp ?? '');
    const token = String(payload.token ?? '');
    const signature = String(payload.signature ?? '');
    const verified = await this.ports.inboundMail.verify({ timestamp, token, signature });
    if (!verified) return { status: 401 };

    const msg = this.ports.inboundMail.parse(payload);

    // Gate 2: replay check. The unique `signature_token` index IS the guard; a conflict
    // means a duplicate delivery of an already-processed webhook — 200, no action.
    const purgeAfter = new Date(
      this.ports.clock.now().getTime() + this.config.RAW_PAYLOAD_RETENTION_DAYS * 86_400_000,
    );
    const insertResult = await inboundMessages.insertOrDuplicate(this.pool, {
      providerMessageId: msg.providerMessageId,
      signatureToken: msg.signatureToken,
      recipientRaw: msg.recipientRaw,
      fromAddress: msg.fromAddresses[0] ?? null,
      fromDomain: msg.fromAddresses[0]?.split('@')[1] ?? null,
      dmarc: msg.dmarc,
      spf: msg.spf,
      dkim: msg.dkim,
      rawPayload: msg.rawPayload,
      purgeAfter,
    });
    if (insertResult.duplicate) return { status: 200 };
    const inboundRow = insertResult.row;

    // F-1 kill switch: hold the entire inbound path closed (no gate below this one ever
    // runs) until INBOUND_REQUESTS_ENABLED is flipped on — meant for holding the path
    // shut while the DMARC/SPF/DKIM field-name guess in mapping.ts is still unverified
    // against a live payload (docs/runbooks/live-spikes.md spike #3). Gated on a verified
    // signature (gate 1 already ran) so this can't become a new unauthenticated write
    // surface of its own.
    if (!this.config.INBOUND_REQUESTS_ENABLED) {
      await inboundMessages.markQuarantined(this.pool, inboundRow.id, 'inbound_disabled');
      return { status: 200 };
    }

    // Gate 3: envelope-recipient parse.
    const parsedAddress = parseRequestAddress(msg.recipientRaw, this.config.INBOUND_DOMAIN);
    if (!parsedAddress) return { status: 406 };

    // Gate 4: tenant + file resolve by token (the ONLY way an address resolves to a file).
    const file = await files.resolveByRequestToken(this.pool, parsedAddress.token);
    if (!file) {
      // F-9: an unknown-but-well-formed token must not be distinguishable from a known
      // token that later fails some other gate (both are silent 200s) — the status code
      // was the oracle Mailgun (and anyone watching from outside) could read (RT-21). 406
      // stays reserved for gate 3's genuinely unparseable-recipient case, which really is
      // the "stop retrying, this route will never work" signal Mailgun should get.
      return { status: 200 };
    }
    await inboundMessages.attachResolution(this.pool, inboundRow.id, {
      tenantId: file.tenant_id,
      fileId: file.id,
    });

    const requesterAddress = msg.fromAddresses[0];
    const fromDomain = requesterAddress ? addressDomain(requesterAddress) : undefined;

    const tenantForSlug = await tenants.findBySlug(this.pool, parsedAddress.slug);
    if (!tenantForSlug || tenantForSlug.id !== file.tenant_id) {
      await this.quarantine(
        parsedAddress.token,
        inboundRow,
        file.tenant_id,
        file.id,
        requesterAddress ?? msg.recipientRaw,
        msg.dmarc,
        'tenant_slug_mismatch',
      );
      return { status: 200 };
    }

    // Gate 5: DMARC. Never re-derived, never inferred as pass from absence.
    if (msg.dmarc !== 'pass') {
      await this.quarantine(
        parsedAddress.token,
        inboundRow,
        file.tenant_id,
        file.id,
        requesterAddress ?? msg.recipientRaw,
        msg.dmarc,
        `dmarc_${msg.dmarc}`,
      );
      return { status: 200 };
    }

    // Gate 6: From-address sanity — exactly one address, domain matches DMARC's evaluated
    // domain when the provider reports one.
    if (msg.fromAddresses.length !== 1 || !requesterAddress || !fromDomain) {
      await this.quarantine(
        parsedAddress.token,
        inboundRow,
        file.tenant_id,
        file.id,
        msg.recipientRaw,
        msg.dmarc,
        'from_address_invalid',
      );
      return { status: 200 };
    }
    // F-2 hardening (docs/security/red-team-report.md, orchestrator decision: safety
    // invariants may only get stricter, PRD precedence rule 4): a `pass` this pipeline
    // cannot align to the `From` domain is not a pass. Previously this branch only fired
    // `if (msg.dmarcDomain && ...)` — a `pass` with NO evaluated domain at all (the
    // provider's `Authentication-Results` present but silent on `header.from`, or the
    // classic guessed field simply absent) fell through and was accepted. An unaligned
    // `pass` and an UNALIGNABLE `pass` are the same risk; both are now quarantined.
    if (!msg.dmarcDomain) {
      await this.quarantine(
        parsedAddress.token,
        inboundRow,
        file.tenant_id,
        file.id,
        requesterAddress,
        msg.dmarc,
        'dmarc_alignment_unknown',
      );
      return { status: 200 };
    }
    if (msg.dmarcDomain.toLowerCase() !== fromDomain) {
      await this.quarantine(
        parsedAddress.token,
        inboundRow,
        file.tenant_id,
        file.id,
        requesterAddress,
        msg.dmarc,
        'dmarc_domain_mismatch',
      );
      return { status: 200 };
    }

    // Gate 7: rate gates (sliding windows).
    const exceeded = await this.rateLimit.checkInboundRequest({
      requesterAddress,
      fileId: file.id,
      tenantId: file.tenant_id,
    });
    if (exceeded.length > 0) {
      await deliveries.insertTerminal(this.pool, {
        tenantId: file.tenant_id,
        fileId: file.id,
        requesterAddress,
        outcome: 'rate_limited',
        reason: `rate_limited:${exceeded.join(',')}`,
        dmarc: msg.dmarc,
        inboundMessageId: inboundRow.id,
      });
      return { status: 200 };
    }

    // Gate 8: allowlist (only when opted in).
    if (file.allowlist_mode === 'allowlist') {
      const allowed = await fileAllowlist.matches(
        this.pool,
        file.tenant_id,
        file.id,
        requesterAddress,
        fromDomain,
      );
      if (!allowed) {
        await deliveries.insertTerminal(this.pool, {
          tenantId: file.tenant_id,
          fileId: file.id,
          requesterAddress,
          outcome: 'not_allowlisted',
          reason: 'not_allowlisted',
          dmarc: msg.dmarc,
          inboundMessageId: inboundRow.id,
        });
        return { status: 200 };
      }
    }

    // Gate 9: expiry.
    const now = this.ports.clock.now();
    const isExpired =
      file.status !== 'ready' || (file.expires_at !== null && file.expires_at <= now);
    if (isExpired) {
      await deliveries.insertTerminal(this.pool, {
        tenantId: file.tenant_id,
        fileId: file.id,
        requesterAddress,
        outcome: 'expired',
        reason: file.status !== 'ready' ? `file_status_${file.status}` : 'expired',
        dmarc: msg.dmarc,
        inboundMessageId: inboundRow.id,
      });
      return { status: 200 };
    }

    // Gate 10: enqueue (transactional outbox) — nothing external has happened yet.
    const deliveryId = await withTransaction(this.pool, async (client) => {
      const delivery = await deliveries.insertQueued(client, {
        tenantId: file.tenant_id,
        fileId: file.id,
        requesterAddress,
        dmarc: msg.dmarc,
        inboundMessageId: inboundRow.id,
      });
      await jobs.enqueue(client, {
        kind: 'delivery.fulfill',
        payload: {
          tenantId: file.tenant_id,
          fileId: file.id,
          deliveryId: delivery.id,
          requesterAddress,
        },
        dedupeKey: `delivery.fulfill:${inboundRow.id}`,
      });
      return delivery.id;
    });

    return { status: 200, deliveryId };
  }

  /**
   * F-7 (`docs/security/red-team-report.md`, RT-20): every pre-authentication quarantine
   * path (gates 4-6's tenant-slug-mismatch, DMARC-fail, and From-sanity failures) funnels
   * through here, and here is where the per-token write cap lives — anyone who has ever
   * been handed a mailto link can trigger this path with zero authentication of their
   * own, so the write itself must be bounded, not just the *rate* of delivery. Beyond
   * `QUARANTINE_PER_TOKEN_PER_HOUR`, the counter still increments (so the cap keeps
   * counting, cheaply) but neither `inbound_messages.quarantined`/`reason` nor a new
   * `deliveries` row is written — the caller still answers 200 either way (never
   * disclosing which branch fired).
   */
  private async quarantine(
    requestToken: string,
    inboundRow: InboundMessageRow,
    tenantId: string,
    fileId: string,
    requesterAddress: string,
    dmarc: string | null,
    reason: string,
  ): Promise<void> {
    const total = await rateLimits.incrementAndSum(
      this.pool,
      `quarantine-token:${requestToken}`,
      QUARANTINE_CAP_WINDOW_MINUTES,
    );
    if (total > this.config.QUARANTINE_PER_TOKEN_PER_HOUR) return;

    await inboundMessages.markQuarantined(this.pool, inboundRow.id, reason);
    await deliveries.insertTerminal(this.pool, {
      tenantId,
      fileId,
      requesterAddress,
      outcome: 'quarantined',
      reason,
      dmarc,
      inboundMessageId: inboundRow.id,
    });
  }
}
