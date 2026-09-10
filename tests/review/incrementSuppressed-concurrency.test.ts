import { describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';

/**
 * Fix pass 8 (code-review.md "Polish pass review — 2026-09-10", confirmed-clean pin,
 * promoted from `tests/review/incrementSuppressed-concurrency.probe.test.ts`): confirms
 * `deliveries.incrementSuppressed`'s `INSERT ... ON CONFLICT ... DO UPDATE` (migration
 * 0006's partial unique index) is race-safe under REAL concurrency, not just the
 * sequential-loop shape `tests/review/quarantine-suppression-and-null-requester.test.ts`
 * exercises. Fires many over-cap quarantine attempts at once via `Promise.all` and
 * asserts exactly one aggregate row results with the full count, no dropped increments
 * and no unique-violation errors surfacing to the caller. No bug was found here — this
 * is a permanent regression test guarding behavior that was already correct.
 */
describe.skipIf(!hasTestDatabase())('incrementSuppressed concurrency', () => {
  it('N concurrent over-cap quarantine attempts collapse into exactly one row with count N', async () => {
    await truncateAll();
    const container = buildTestContainer({ QUARANTINE_PER_TOKEN_PER_HOUR: 1 });
    const { tenant, file } = await createTenantWithReadyFile(
      container,
      'concurrent-flood@example.com',
    );

    const N = 25;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        container.services.requestPipeline.handleWebhook(
          buildSignedWebhookPayload(container, {
            requestToken: file.request_token,
            tenantSlug: tenant.slug,
            fromAddress: `attacker${i}@relay.test`,
            dmarc: 'fail',
          }),
        ),
      ),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toEqual([]);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 1000 });
    const suppressed = rows.filter((r) => r.reason === 'suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.suppressed_count).toBe(N - 1); // first attempt is allowed at cap=1, ordinary quarantine
  });
});
