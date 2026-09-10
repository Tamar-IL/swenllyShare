import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { deliveryAddressLabel } from '../../src/lib/presentation.js';

/**
 * Fix pass 7 (docs/reviews/critic-report.md, Minor findings carried since fix pass 5):
 *
 *  1. F-7's quarantine cap used to go fully silent past `QUARANTINE_PER_TOKEN_PER_HOUR` —
 *     now it writes/bumps one aggregate `suppressed` row instead.
 *  2. Gate 6's From-address-sanity failure (and the two earlier quarantine gates) used to
 *     store `msg.recipientRaw` — the file's OWN inbound address — as `requester_address`
 *     whenever `From` couldn't be resolved to exactly one address. It now stores `null`.
 */
describe.skipIf(!hasTestDatabase())('quarantine suppression + null requester_address', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('past the per-token quarantine cap, writes exactly ONE aggregate row that keeps incrementing', async () => {
    const container = buildTestContainer({ QUARANTINE_PER_TOKEN_PER_HOUR: 3 });
    const { tenant, file } = await createTenantWithReadyFile(container, 'flood@example.com');

    // 3 allowed quarantine writes (dmarc=fail fires gate 5, well before the rate gate),
    // then 5 more that must all be suppressed into the same aggregate row.
    for (let i = 0; i < 8; i++) {
      await container.services.requestPipeline.handleWebhook(
        buildSignedWebhookPayload(container, {
          requestToken: file.request_token,
          tenantSlug: tenant.slug,
          fromAddress: `attacker${i}@relay.test`,
          dmarc: 'fail',
        }),
      );
    }

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 100 });
    const ordinaryQuarantined = rows.filter(
      (r) => r.outcome === 'quarantined' && r.reason !== 'suppressed',
    );
    const suppressed = rows.filter((r) => r.reason === 'suppressed');

    expect(ordinaryQuarantined).toHaveLength(3);
    expect(suppressed).toHaveLength(1); // ONE row, not one per suppressed attempt
    expect(suppressed[0]?.outcome).toBe('quarantined');
    expect(suppressed[0]?.requester_address).toBeNull();
    expect(suppressed[0]?.suppressed_count).toBe(5); // 8 total - 3 allowed = 5 suppressed
    expect(deliveryAddressLabel(suppressed[0]!)).toBe('5 נוספות הושתקו');
  });

  it('a second flood in the SAME hour bumps the same row rather than creating a new one', async () => {
    const container = buildTestContainer({ QUARANTINE_PER_TOKEN_PER_HOUR: 1 });
    const { tenant, file } = await createTenantWithReadyFile(container, 'flood2@example.com');

    for (let i = 0; i < 4; i++) {
      await container.services.requestPipeline.handleWebhook(
        buildSignedWebhookPayload(container, {
          requestToken: file.request_token,
          tenantSlug: tenant.slug,
          fromAddress: `a${i}@relay.test`,
          dmarc: 'fail',
        }),
      );
    }
    let rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 100 });
    let suppressed = rows.filter((r) => r.reason === 'suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.suppressed_count).toBe(3);

    // More requests in the same hour: the SAME row bumps further, no second row appears.
    for (let i = 4; i < 6; i++) {
      await container.services.requestPipeline.handleWebhook(
        buildSignedWebhookPayload(container, {
          requestToken: file.request_token,
          tenantSlug: tenant.slug,
          fromAddress: `a${i}@relay.test`,
          dmarc: 'fail',
        }),
      );
    }
    rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 100 });
    suppressed = rows.filter((r) => r.reason === 'suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.suppressed_count).toBe(5);
  });

  it('an unparseable/ambiguous From address records requester_address = null, never the inbound address', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'ambiguous@example.com');

    // Two From addresses -> gate 6 (from_address_invalid).
    await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'first@example.com',
        extraFromAddresses: ['second@example.com'],
        dmarc: 'pass',
      }),
    );

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('from_address_invalid');
    // `null`, never the file's own request token / inbound address (the bug this
    // replaced) and never any other stand-in value.
    expect(rows[0]?.requester_address).toBeNull();
    expect(deliveryAddressLabel(rows[0]!)).toBe('לא ניתן לזהות שולח');
  });
});
