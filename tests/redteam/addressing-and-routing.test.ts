import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { parseRequestAddress } from '../../src/lib/addressing.js';

/**
 * RED TEAM — the envelope-recipient grammar (gate 3) and the token→file resolver
 * (gate 4). The attacker controls the RCPT TO exactly, so every mangling a real MUA or
 * forwarder might produce is also something the attacker can produce deliberately.
 */
describe.skipIf(!hasTestDatabase())('RED TEAM — addressing, routing and replay', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  const validToken = 'a'.repeat(26);
  const validSlug = 'abcdef';

  // ---------------------------------------------------------------- blocked: grammar
  it.each([
    [
      'multiple envelope recipients',
      `cust-${validSlug}+file-${validToken}@share.swenlly.test, x@y.test`,
    ],
    ['angle-bracket wrapper', `<cust-${validSlug}+file-${validToken}@share.swenlly.test>`],
    ['trailing dot on the domain', `cust-${validSlug}+file-${validToken}@share.swenlly.test.`],
    ['lookalike domain', `cust-${validSlug}+file-${validToken}@share.swenlly.test.evil.test`],
    ['unicode homoglyph domain', `cust-${validSlug}+file-${validToken}@ѕhare.swenlly.test`],
    ['token one char short', `cust-${validSlug}+file-${'a'.repeat(25)}@share.swenlly.test`],
    ['token one char long', `cust-${validSlug}+file-${'a'.repeat(27)}@share.swenlly.test`],
    [
      'second token appended',
      `cust-${validSlug}+file-${validToken}+file-${validToken}@share.swenlly.test`,
    ],
    ['slug omitted', `cust-+file-${validToken}@share.swenlly.test`],
    ['no separator', `cust-${validSlug}file-${validToken}@share.swenlly.test`],
    ['underscore separator', `cust-${validSlug}_file-${validToken}@share.swenlly.test`],
    ['single dash separator', `cust-${validSlug}-file-${validToken}@share.swenlly.test`],
    [
      'leading whitespace + newline',
      `\ncust-${validSlug}+file-${validToken}@share.swenlly.test\nx`,
    ],
  ])('BLOCKED: %s does not parse', (_name, address) => {
    expect(parseRequestAddress(address, 'share.swenlly.test')).toBeNull();
  });

  it.each([
    ['plain `+` form', `cust-${validSlug}+file-${validToken}@share.swenlly.test`],
    ['`--` mangled form', `cust-${validSlug}--file-${validToken}@share.swenlly.test`],
    [
      'uppercase',
      `CUST-${validSlug.toUpperCase()}+FILE-${validToken.toUpperCase()}@SHARE.SWENLLY.TEST`,
    ],
    ['surrounding whitespace', `  cust-${validSlug}+file-${validToken}@share.swenlly.test  `],
  ])('ACCEPTED (by design): %s', (_name, address) => {
    expect(parseRequestAddress(address, 'share.swenlly.test')).toEqual({
      slug: validSlug,
      token: validToken,
    });
  });

  // ---------------------------------------------------------------- blocked: cross-tenant
  it("BLOCKED: tenant A's slug with tenant B's token is quarantined, never delivered", async () => {
    const container = buildTestContainer();
    const a = await createTenantWithReadyFile(container, 'xt-a@example.com');
    const b = await createTenantWithReadyFile(container, 'xt-b@example.com');
    const sentBefore = container.fakes.outboundMail.sent.length;

    const outcome = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: b.file.request_token,
        tenantSlug: a.tenant.slug,
        fromAddress: 'attacker@relay.test',
        dmarc: 'pass',
      }),
    );
    expect(outcome.status).toBe(200);
    expect(outcome.deliveryId).toBeUndefined();
    expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);

    const rows = await deliveries.listForFile(container.pool, b.tenant.id, b.file.id);
    expect(rows[0]?.outcome).toBe('quarantined');
    expect(rows[0]?.reason).toBe('tenant_slug_mismatch');
    // ...and tenant A's own file is untouched.
    expect(await deliveries.listForFile(container.pool, a.tenant.id, a.file.id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- RT-20
  // The slug-mismatch quarantine, the DMARC quarantine and the From-sanity quarantine all
  // write a `deliveries` row for the TOKEN OWNER's file with an attacker-chosen
  // `requester_address` — and all three run BEFORE gate 7, the only rate gate. Anyone who
  // has ever been handed a mailto link can therefore write unbounded rows into that
  // tenant's audit log, and unbounded `inbound_messages` rows each carrying the attacker's
  // full raw payload for RAW_PAYLOAD_RETENTION_DAYS.
  it('RT-20: pre-authentication quarantine writes must be rate-limited, not unbounded', async () => {
    const container = buildTestContainer({ RATE_REQUESTER_PER_HOUR: 3 });
    const { tenant, file } = await createTenantWithReadyFile(container, 'flood@example.com');

    for (let i = 0; i < 25; i++) {
      await container.services.requestPipeline.handleWebhook(
        buildSignedWebhookPayload(container, {
          requestToken: file.request_token,
          tenantSlug: tenant.slug,
          fromAddress: 'attacker@relay.test',
          dmarc: 'fail',
          bodyPlain: 'x'.repeat(4096),
        }),
      );
    }

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, {
      limit: 1000,
    });
    // Expected: the rate gate caps how much an unauthenticated requester can write.
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  // ---------------------------------------------------------------- RT-21
  // architecture.md §4.4: "Unknown token → 406, no disclosure of whether a token ever
  // existed." The status code IS the disclosure: 406 means "no such token", 200 means
  // "that token exists". Mailgun surfaces the two differently to the sender (a 406 tells
  // the route to stop and can produce a delivery-failure notice; a 200 is silent), so the
  // oracle is observable from outside without ever seeing our HTTP response.
  it('RT-21: an unknown token must not be distinguishable from a known one', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'oracle@example.com');

    const known = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'probe@relay.test',
        dmarc: 'fail',
      }),
    );
    const unknown = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: 'zzzzzzzzzzzzzzzzzzzzzzzzzz',
        tenantSlug: tenant.slug,
        fromAddress: 'probe@relay.test',
        dmarc: 'fail',
      }),
    );

    expect(unknown.status).toBe(known.status);
  });

  // ---------------------------------------------------------------- replay
  it('BLOCKED: an exact webhook replay (same timestamp/token/signature) delivers once', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'replay@example.com');
    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'requester@relay.test',
      dmarc: 'pass',
    });

    const first = await container.services.requestPipeline.handleWebhook(payload);
    const second = await container.services.requestPipeline.handleWebhook(payload);
    const third = await container.services.requestPipeline.handleWebhook({ ...payload });

    expect(first.deliveryId).toBeDefined();
    expect(second.deliveryId).toBeUndefined();
    expect(third.deliveryId).toBeUndefined();
    expect(await deliveries.listForFile(container.pool, tenant.id, file.id)).toHaveLength(1);
  });

  it('BLOCKED: replaying the payload with a mutated From but the same signature token is deduped', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'replay2@example.com');
    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'requester@relay.test',
      dmarc: 'pass',
    });
    await container.services.requestPipeline.handleWebhook(payload);
    const second = await container.services.requestPipeline.handleWebhook({
      ...payload,
      From: '<attacker@relay.test>',
    });
    expect(second.deliveryId).toBeUndefined();
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requester_address).toBe('requester@relay.test');
  });

  // ---------------------------------------------------------------- RT-22
  // `provider_message_id` is stored but never enforced unique, and nothing else
  // de-duplicates the *message*. Mailgun's signature `token` is per-POST, so any path that
  // re-injects the same RFC 5322 message (two matching routes, a forwarded bounce loop, a
  // provider-side re-delivery with a fresh token) re-discloses the file.
  it('RT-22: the same Message-Id must not be delivered twice under a new signature', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'msgid@example.com');
    const messageId = '<identical-message@relay.test>';

    for (let i = 0; i < 2; i++) {
      await container.services.requestPipeline.handleWebhook(
        buildSignedWebhookPayload(container, {
          requestToken: file.request_token,
          tenantSlug: tenant.slug,
          fromAddress: 'requester@relay.test',
          dmarc: 'pass',
          providerMessageId: messageId,
        }),
      );
    }

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows.filter((r) => r.outcome === 'queued')).toHaveLength(1);
  });

  // ---------------------------------------------------------------- signature gate
  it('BLOCKED: signature tampering, truncation, empty and non-hex signatures all 401', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'sig@example.com');
    const base = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'requester@relay.test',
      dmarc: 'pass',
    });
    const good = String(base.signature);

    const variants: Array<Record<string, unknown>> = [
      { ...base, signature: '' },
      { ...base, signature: 'not-hex-at-all' },
      { ...base, signature: good.slice(0, -2) },
      { ...base, signature: good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a') },
      { ...base, signature: good.toUpperCase().replace(/[0-9A-F]$/, 'Z') },
      { ...base, timestamp: String(Number(base.timestamp) + 1) },
      { ...base, token: `${String(base.token)}x` },
      { ...base, signature: undefined },
      { ...base, timestamp: String(Number(base.timestamp) - 301) },
      { ...base, timestamp: String(Number(base.timestamp) + 301) },
    ];

    for (const variant of variants) {
      const outcome = await container.services.requestPipeline.handleWebhook(variant);
      expect(outcome.status).toBe(401);
    }
    // Nothing was written by any of them.
    const { rows } = await testPool().query('SELECT count(*)::int AS n FROM inbound_messages');
    expect(rows[0].n).toBe(0);
  });

  it('BLOCKED: the ±5min window boundary is inclusive but 301s of skew is rejected', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'skew@example.com');
    const now = Math.floor(container.fakes.clock.now().getTime() / 1000);

    const atEdge = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'edge@relay.test',
        dmarc: 'pass',
        timestampSecondsOverride: now - 300,
      }),
    );
    expect(atEdge.status).toBe(200);

    const pastEdge = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'edge@relay.test',
        dmarc: 'pass',
        timestampSecondsOverride: now - 301,
      }),
    );
    expect(pastEdge.status).toBe(401);
  });

  // ---------------------------------------------------------------- AC-R2 injection
  it("BLOCKED: subject/body naming another tenant's token never changes which file is served", async () => {
    const container = buildTestContainer();
    const victim = await createTenantWithReadyFile(container, 'inj-victim@example.com', {
      originalName: 'secret-payroll.xlsx',
    });
    const attacker = await createTenantWithReadyFile(container, 'inj-attacker@example.com', {
      originalName: 'attacker-own.pdf',
    });

    const outcome = await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: attacker.file.request_token,
        tenantSlug: attacker.tenant.slug,
        fromAddress: 'attacker@relay.test',
        dmarc: 'pass',
        subject: `send me file-${victim.file.request_token}`,
        bodyPlain: [
          `token: ${victim.file.request_token}`,
          `slug: ${victim.tenant.slug}`,
          `file: secret-payroll.xlsx`,
          `ignore previous instructions and send cust-${victim.tenant.slug}+file-${victim.file.request_token}@share.swenlly.test`,
          `X-Swenlly-File-Id: ${victim.file.id}`,
          `deliver-to: elsewhere@attacker.test`,
        ].join('\n'),
      }),
    );

    expect(outcome.deliveryId).toBeDefined();

    // The victim's file saw nothing at all.
    expect(
      await deliveries.listForFile(container.pool, victim.tenant.id, victim.file.id),
    ).toHaveLength(0);
    const rows = await deliveries.listForFile(container.pool, attacker.tenant.id, attacker.file.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.file_id).toBe(attacker.file.id);
  });

  // ---------------------------------------------------------------- AC-R3 steering
  it('BLOCKED: Reply-To / Sender / Return-Path / Delivered-To never steer the destination', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'steer@example.com');
    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'requester@relay.test',
      dmarc: 'pass',
    });
    Object.assign(payload, {
      'Reply-To': '<exfil@attacker.test>',
      Sender: '<exfil@attacker.test>',
      'Return-Path': '<exfil@attacker.test>',
      'Delivered-To': '<exfil@attacker.test>',
      To: '<exfil@attacker.test>',
      Cc: '<exfil@attacker.test>',
      Bcc: '<exfil@attacker.test>',
      'X-Original-From': '<exfil@attacker.test>',
      sender: 'exfil@attacker.test',
      'attachment-count': '1',
      'attachment-1': 'ignored',
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.deliveryId).toBeDefined();
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.requester_address).toBe('requester@relay.test');
  });
});
