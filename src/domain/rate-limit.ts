import type pg from 'pg';
import { rateLimits } from '../db/repositories/rate-limits.js';

export type RateLimitBucket = 'requester' | 'file' | 'tenant';

export interface RateLimitConfig {
  RATE_REQUESTER_PER_HOUR: number;
  RATE_FILE_PER_HOUR: number;
  RATE_TENANT_PER_HOUR: number;
}

const WINDOW_MINUTES = 60;

/**
 * The three sliding-window rate gates the inbound pipeline enforces at gate 7
 * (architecture.md §4.7): per requester address, per file, per tenant — each backed by
 * `rate_limit_counters` (architecture.md §3). Every bucket is incremented regardless of
 * the others' outcome (a soft over-count on a rejected request is harmless); the caller
 * decides on the combined `allowed` result.
 */
export class RateLimitService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: RateLimitConfig,
  ) {}

  private limitFor(bucket: RateLimitBucket): number {
    switch (bucket) {
      case 'requester':
        return this.config.RATE_REQUESTER_PER_HOUR;
      case 'file':
        return this.config.RATE_FILE_PER_HOUR;
      case 'tenant':
        return this.config.RATE_TENANT_PER_HOUR;
    }
  }

  /**
   * Checks the pipeline's three gates at once (each incremented unconditionally) and
   * returns which ones are already over limit — an empty array means the request may
   * proceed.
   */
  async checkInboundRequest(identifiers: {
    requesterAddress: string;
    fileId: string;
    tenantId: string;
  }): Promise<RateLimitBucket[]> {
    const checks: Array<[RateLimitBucket, string]> = [
      ['requester', identifiers.requesterAddress],
      ['file', identifiers.fileId],
      ['tenant', identifiers.tenantId],
    ];
    const exceeded: RateLimitBucket[] = [];
    for (const [bucket, identifier] of checks) {
      const total = await rateLimits.incrementAndSum(
        this.pool,
        `${bucket}:${identifier}`,
        WINDOW_MINUTES,
      );
      if (total > this.limitFor(bucket)) exceeded.push(bucket);
    }
    return exceeded;
  }
}
