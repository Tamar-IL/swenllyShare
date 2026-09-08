import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';

/**
 * CRITIC F-B re-check (`docs/reviews/critic-report.md`) — the four probe payloads that
 * proved the DMARC gate forgeable, run through the FULL pipeline this time (not just the
 * mapper — see `tests/unit/mailgun-mapping.test.ts`'s "fix pass 5, F-B" describe block for
 * the mapper-level versions of the same four). `MAILGUN_AUTHSERV_ID` is configured to a
 * genuine, non-public value (never `INBOUND_DOMAIN`, per F-B fix item 4) — the same
 * `buildTestContainer()` default every other test in this suite now gets.
 *
 * Re-check protocol item 2: "does `message-headers`-absent now fail closed end to end, at
 * the pipeline and not only in the mapper."
 */
describe.skipIf(!hasTestDatabase())(
  'CRITIC F-B re-check: probe payloads A-D at the pipeline level',
  () => {
    beforeEach(async () => {
      await truncateAll();
    });

    it('A: no message-headers, attacker top-level Authentication-Results with a bogus authserv-id -> quarantined dmarc_unknown', async () => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(container, 'probe-a@example.com');
      const payload = buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'attacker@evil.test',
        includeMessageHeaders: false,
      });
      payload['Authentication-Results'] =
        'totally-made-up.evil.test; dmarc=pass header.from=evil.test';

      const outcome = await container.services.requestPipeline.handleWebhook(payload);
      expect(outcome.deliveryId).toBeUndefined();
      const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
      expect(rows[0]?.outcome).toBe('quarantined');
      expect(rows[0]?.reason).toBe('dmarc_unknown');
    });

    it('B: no message-headers, attacker top-level dmarc/dmarc-domain fields -> quarantined dmarc_unknown', async () => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(container, 'probe-b@example.com');
      const payload = buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'attacker@evil.test',
        includeMessageHeaders: false,
      });
      payload.dmarc = 'pass';
      payload['dmarc-domain'] = 'evil.test';

      const outcome = await container.services.requestPipeline.handleWebhook(payload);
      expect(outcome.deliveryId).toBeUndefined();
      const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
      expect(rows[0]?.outcome).toBe('quarantined');
      expect(rows[0]?.reason).toBe('dmarc_unknown');
    });

    it('C: message-headers present, Mailgun stamps nothing itself, attacker forges an Authentication-Results entry naming the (guessable) OLD public INBOUND_DOMAIN value -> quarantined dmarc_unknown', async () => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(container, 'probe-c@example.com');
      const payload = buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'attacker@evil.test',
        includeMessageHeaders: false,
      });
      // The attacker's own forged trace header — names the value a public
      // `INBOUND_DOMAIN`-derived guess would have produced (this container's own
      // `INBOUND_DOMAIN`), NOT the real, properly-configured `MAILGUN_AUTHSERV_ID`
      // (`mxa.mailgun.test`, `buildTestContainer`'s default — see F-B fix item 4).
      payload['message-headers'] = JSON.stringify([
        ['From', payload.From],
        [
          'Authentication-Results',
          `${container.config.INBOUND_DOMAIN}; dmarc=pass header.from=evil.test`,
        ],
      ]);

      const outcome = await container.services.requestPipeline.handleWebhook(payload);
      expect(outcome.deliveryId).toBeUndefined();
      const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
      expect(rows[0]?.outcome).toBe('quarantined');
      expect(rows[0]?.reason).toBe('dmarc_unknown');
    });

    it("D: message-headers present with a genuine dmarc=fail on top and the attacker's pass below -> quarantined dmarc_fail (defense holds)", async () => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(container, 'probe-d@example.com');
      const payload = buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'attacker@evil.test',
        includeMessageHeaders: false,
      });
      const realAuthservId = container.config.MAILGUN_AUTHSERV_ID;
      payload['message-headers'] = JSON.stringify([
        ['From', payload.From],
        // Mailgun's own, genuine stamp — matches the real authserv-id, topmost.
        ['Authentication-Results', `${realAuthservId}; dmarc=fail header.from=evil.test`],
        // The attacker's own forged entry, further down — correctly skipped.
        ['Authentication-Results', `${realAuthservId}; dmarc=pass header.from=evil.test`],
      ]);

      const outcome = await container.services.requestPipeline.handleWebhook(payload);
      expect(outcome.deliveryId).toBeUndefined();
      const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
      expect(rows[0]?.outcome).toBe('quarantined');
      expect(rows[0]?.reason).toBe('dmarc_fail');
    });
  },
);
