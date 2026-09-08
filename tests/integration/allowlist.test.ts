import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';

describe.skipIf(!hasTestDatabase())('allowlist mode (architecture.md §0, gate 8)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('default mode ("open"): any DMARC-verified requester is allowed regardless of address', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'open@example.com');
    expect(file.allowlist_mode).toBe('open');

    const outcome = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'anyone@wherever.example',
        dmarc: 'pass',
      }),
    );
    expect(outcome.status).toBe(200);
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('queued');
  });

  it('allowlist mode: a non-matching address is rejected with not_allowlisted, a matching one proceeds', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'allowlisted@example.com');

    await container.services.settings.updateSettings(
      tenant.id,
      file.id,
      { allowlistMode: 'allowlist', allowlist: ['friend@example.com'] },
      container.ports.clock,
    );

    const rejected = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'stranger@example.com',
        dmarc: 'pass',
      }),
    );
    expect(rejected.status).toBe(200);

    const allowed = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'friend@example.com',
        dmarc: 'pass',
      }),
    );
    expect(allowed.status).toBe(200);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    const byOutcome = Object.fromEntries(rows.map((r) => [r.requester_address, r.outcome]));
    expect(byOutcome['stranger@example.com']).toBe('not_allowlisted');
    expect(byOutcome['friend@example.com']).toBe('queued');
  });

  it('a @domain allowlist pattern matches any local part at that domain', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'domainallow@example.com');

    await container.services.settings.updateSettings(
      tenant.id,
      file.id,
      { allowlistMode: 'allowlist', allowlist: ['@partner.example'] },
      container.ports.clock,
    );

    const outcome = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'anyone@partner.example',
        dmarc: 'pass',
      }),
    );
    expect(outcome.status).toBe(200);
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('queued');
  });

  it('SettingsService rejects a malformed allowlist pattern', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'badpattern@example.com');

    await expect(
      container.services.settings.updateSettings(
        tenant.id,
        file.id,
        { allowlistMode: 'allowlist', allowlist: ['not-an-address-or-domain'] },
        container.ports.clock,
      ),
    ).rejects.toThrow(/invalid allowlist pattern/);
  });
});
