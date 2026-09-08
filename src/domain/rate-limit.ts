import type { Pool } from '../db/pool.js';
import { rateLimits } from '../db/repositories/rate-limits.js';
import { addressDomain } from '../lib/email-address.js';

export type RateLimitBucket = 'requester' | 'file' | 'tenant' | 'domain';

export interface RateLimitConfig {
  RATE_REQUESTER_PER_HOUR: number;
  RATE_FILE_PER_HOUR: number;
  RATE_TENANT_PER_HOUR: number;
  RATE_DOMAIN_PER_HOUR: number;
}

const WINDOW_MINUTES = 60;

/**
 * F-8 (`docs/security/red-team-report.md`, RT-30/RT-30b/RT-31): normalizes the requester
 * bucket key so `mallory+0@host`, `mallory+1@host`, ... share one bucket (strip a `+tag`
 * sub-address) and so Gmail's dot-insensitive local parts (`m.allory@gmail.com` ==
 * `mallory@gmail.com`) do too — scoped to `gmail.com`/`googlemail.com` specifically,
 * because dot-insensitivity is that provider's own quirk, not a general email property a
 * bucket key can assume for every domain. Case-folding already happened in
 * `src/lib/email-address.ts` before this address ever reaches here.
 */
function normalizeRequesterBucketKey(address: string): string {
  const at = address.lastIndexOf('@');
  if (at === -1) return address;
  let local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const plusIdx = local.indexOf('+');
  if (plusIdx !== -1) local = local.slice(0, plusIdx);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
  }
  return `${local}@${domain}`;
}

/**
 * The pipeline's rate gates (architecture.md §4.7, gate 7), now four buckets instead of
 * three. `requester`/`file`/`tenant` are unchanged from the original design — every
 * bucket is incremented regardless of the others' outcome, a soft over-count on a
 * rejected request is harmless. `domain` is F-8's fix, in two parts:
 *
 * 1. A flat, global per-hour ceiling per requester domain (`RATE_DOMAIN_PER_HOUR`) —
 *    catches a domain spreading requests across many files/tenants, the same shape of
 *    protection the tenant bucket gives per-tenant.
 * 2. A **fairness check scoped to one file**, applied only when the plain file bucket
 *    would otherwise reject: if the requesting domain's own share of this file's traffic
 *    so far is at most half of the file's total, the request is let through even though
 *    the raw file counter is over `RATE_FILE_PER_HOUR` — because in that situation the
 *    file's budget isn't actually exhausted for THIS requester, it's been monopolized by
 *    a different, dominant domain (RT-31's exact scenario: one attacker domain sends
 *    exactly `RATE_FILE_PER_HOUR` requests, then a legitimate requester on a different
 *    domain must still get through). A domain that IS the dominant one over half the
 *    file's traffic gets no such exception — the plain per-file cap still applies to it,
 *    which is what keeps `RATE_FILE_PER_HOUR: many distinct requesters against one file
 *    still trip the per-file limit` (same domain, no fairness question to arbitrate)
 *    passing unchanged.
 *
 * Known residual gap, accepted rather than solved here: a determined attacker who rotates
 * across many distinct DOMAINS (not just many local-parts under one domain) could use the
 * fairness exception to keep exceeding a file's raw budget indefinitely, since each new
 * domain looks under-represented in isolation. `RATE_TENANT_PER_HOUR` still bounds that
 * across the whole tenant regardless of how the traffic is sliced by domain, and
 * `RATE_DOMAIN_PER_HOUR` bounds any one domain's total footprint — closing the gap
 * completely would need a genuinely different mechanism (e.g. a hard ceiling on distinct
 * domains served per file per hour), which no pinned regression requires and which I did
 * not build without a concrete threat model asking for it.
 */
export class RateLimitService {
  constructor(
    private readonly pool: Pool,
    private readonly config: RateLimitConfig,
  ) {}

  async checkInboundRequest(identifiers: {
    requesterAddress: string;
    fileId: string;
    tenantId: string;
  }): Promise<RateLimitBucket[]> {
    const domain = addressDomain(identifiers.requesterAddress);
    const requesterKey = normalizeRequesterBucketKey(identifiers.requesterAddress);
    const exceeded: RateLimitBucket[] = [];

    const requesterTotal = await rateLimits.incrementAndSum(
      this.pool,
      `requester:${requesterKey}`,
      WINDOW_MINUTES,
    );
    if (requesterTotal > this.config.RATE_REQUESTER_PER_HOUR) exceeded.push('requester');

    const domainGlobalTotal = await rateLimits.incrementAndSum(
      this.pool,
      `domain:${domain}`,
      WINDOW_MINUTES,
    );
    if (domainGlobalTotal > this.config.RATE_DOMAIN_PER_HOUR) exceeded.push('domain');

    const domainFileTotal = await rateLimits.incrementAndSum(
      this.pool,
      `domain-file:${identifiers.fileId}:${domain}`,
      WINDOW_MINUTES,
    );
    const fileTotal = await rateLimits.incrementAndSum(
      this.pool,
      `file:${identifiers.fileId}`,
      WINDOW_MINUTES,
    );
    if (fileTotal > this.config.RATE_FILE_PER_HOUR) {
      const domainIsFair = domainFileTotal <= fileTotal / 2;
      if (!domainIsFair) exceeded.push('file');
    }

    const tenantTotal = await rateLimits.incrementAndSum(
      this.pool,
      `tenant:${identifiers.tenantId}`,
      WINDOW_MINUTES,
    );
    if (tenantTotal > this.config.RATE_TENANT_PER_HOUR) exceeded.push('tenant');

    return exceeded;
  }
}
