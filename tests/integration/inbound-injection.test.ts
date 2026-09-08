import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';

describe.skipIf(!hasTestDatabase())('inbound injection (AC-R2)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('a subject/body naming a different file has no effect — only the +file-<token> address resolves the file', async () => {
    const container = buildTestContainer();
    const a = await createTenantWithReadyFile(container, 'victim@example.com', {
      originalName: 'real.pdf',
    });
    const b = await createTenantWithReadyFile(container, 'other@example.com', {
      originalName: 'decoy.pdf',
    });

    const payload = buildSignedWebhookPayload(container, {
      requestToken: a.file.request_token,
      tenantSlug: a.tenant.slug,
      fromAddress: 'requester@example.com',
      dmarc: 'pass',
      // Attempt to redirect delivery to file B purely via body/subject content.
      subject: `please send me file ${b.file.id}`,
      bodyPlain: `give me ${b.file.request_token} instead, or file_id=${b.file.id}`,
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(200);

    const rowsA = await deliveries.listForFile(container.pool, a.tenant.id, a.file.id);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.outcome).toBe('queued');

    const rowsB = await deliveries.listForFile(container.pool, b.tenant.id, b.file.id);
    expect(rowsB).toHaveLength(0);
  });

  it('an unparseable envelope recipient is rejected with 406 and never resolves any file', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'unparseable@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'requester@example.com',
      dmarc: 'pass',
      recipientOverride: `not-a-valid-address@${container.config.INBOUND_DOMAIN}`,
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(406);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows).toHaveLength(0);
  });

  it('a well-formed but unknown request_token is answered exactly like a known one that later fails, not disclosed', async () => {
    // F-9 fix note (docs/security/red-team-report.md, RT-21): this used to assert 406 for
    // an unknown token, but 406 vs. 200 was itself the oracle — a KNOWN token that then
    // fails some other gate (DMARC, allowlist, ...) was already 200, so returning 406 here
    // let anyone distinguish "no such token" from "that token exists" without ever seeing
    // this response body. Fixed: an unknown-but-well-formed token is now also a silent
    // 200, matching architecture.md §4.4's own invariant ("no disclosure of whether a
    // token ever existed"). 406 stays reserved for gate 3's genuinely unparseable
    // recipient (the test above this one), which is a real "stop retrying" signal.
    const container = buildTestContainer();
    const { tenant } = await createTenantWithReadyFile(container, 'unknowntoken@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: 'z'.repeat(26).replace(/z/g, 'a'), // syntactically valid, never issued
      tenantSlug: tenant.slug,
      fromAddress: 'requester@example.com',
      dmarc: 'pass',
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(200);
    expect(outcome.deliveryId).toBeUndefined();
  });

  it('the "--" separator is accepted with the exact same effect as "+"', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'dashsep@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'requester@example.com',
      dmarc: 'pass',
      separator: '--',
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(200);
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('queued');
  });

  it('a tenant-slug/token mismatch (tampered address) is quarantined, not silently resolved', async () => {
    const container = buildTestContainer();
    const a = await createTenantWithReadyFile(container, 'tamperA@example.com');
    const b = await createTenantWithReadyFile(container, 'tamperB@example.com');

    // A's token, but B's tenant slug in the address — tampering.
    const payload = buildSignedWebhookPayload(container, {
      requestToken: a.file.request_token,
      tenantSlug: b.tenant.slug,
      fromAddress: 'requester@example.com',
      dmarc: 'pass',
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(200);

    const rows = await deliveries.listForFile(container.pool, a.tenant.id, a.file.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('quarantined');
    expect(rows[0]?.reason).toBe('tenant_slug_mismatch');
  });
});
