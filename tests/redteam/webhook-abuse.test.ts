import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { buildApp } from '../../src/app.js';

/**
 * RED TEAM — `POST /webhooks/mailgun/inbound` as an unauthenticated public endpoint.
 *
 * Gate 1 (HMAC) is the endpoint's only authentication, but it runs INSIDE
 * `RequestPipeline.handleWebhook` — i.e. after `parseWebhookBody` has already
 * materialised the entire request body in memory. architecture.md §10 lists a "body size
 * cap" among the webhook's security properties; the route sets no `bodyLimit`, and
 * `@fastify/multipart` is registered with no options, so the multipart branch is bounded
 * only by `parts: 1000` × busboy's 1 MB default field size.
 */

function buildMultipartFields(fields: Array<[string, string]>): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----swenllyRedTeam${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`),
      Buffer.from(value),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe.skipIf(!hasTestDatabase())('RED TEAM — public webhook endpoint abuse', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  // ---------------------------------------------------------------- RT-40
  it.fails(
    'RT-40: an oversized multipart body must be rejected before it is buffered, not after a 401',
    async () => {
      const container = buildTestContainer();
      const app = await buildApp({ container });

      // 200 junk field parts × 128 KiB = 25 MiB, with a signature that cannot verify.
      const junk = 'A'.repeat(128 * 1024);
      const fields: Array<[string, string]> = [
        ['timestamp', String(Math.floor(Date.now() / 1000))],
        ['token', 'anything'],
        ['signature', 'deadbeef'.repeat(8)],
      ];
      for (let i = 0; i < 200; i++) fields.push([`junk-${i}`, junk]);
      const { body, contentType } = buildMultipartFields(fields);
      expect(body.length).toBeGreaterThan(20 * 1024 * 1024);

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/mailgun/inbound',
        payload: body,
        headers: { 'content-type': contentType },
      });

      // Expected: a size cap refuses the body. Observed: 401 — the server parsed all
      // 25 MiB into a JS object first, then decided the signature was bad.
      expect(res.statusCode).toBe(413);
    },
  );

  it('OBSERVED: the multipart branch accepts and fully buffers a 25 MiB unauthenticated body', async () => {
    // The other half of RT-40, written as a passing test so the current behaviour is
    // pinned and the fix is visibly a behaviour change.
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const junk = 'A'.repeat(128 * 1024);
    const fields: Array<[string, string]> = [
      ['timestamp', String(Math.floor(Date.now() / 1000))],
      ['token', 'anything'],
      ['signature', 'deadbeef'.repeat(8)],
    ];
    for (let i = 0; i < 200; i++) fields.push([`junk-${i}`, junk]);
    const { body, contentType } = buildMultipartFields(fields);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/mailgun/inbound',
      payload: body,
      headers: { 'content-type': contentType },
    });
    expect(res.statusCode).toBe(401);
  });

  it('BLOCKED: the urlencoded branch IS capped by Fastify\'s default 1 MB bodyLimit', async () => {
    // Contrast case — proves the gap is specific to the multipart branch, which is the
    // shape Mailgun uses whenever the inbound message carried an attachment.
    const container = buildTestContainer();
    const app = await buildApp({ container });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/mailgun/inbound',
      payload: `token=x&signature=y&timestamp=1&junk=${'A'.repeat(2 * 1024 * 1024)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(413);
  });

  // ---------------------------------------------------------------- attachments
  it('BLOCKED: an inbound attachment is drained and never influences resolution or reply', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const victim = await createTenantWithReadyFile(container, 'att-victim@example.com');
    const attacker = await createTenantWithReadyFile(container, 'att-attacker@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: attacker.file.request_token,
      tenantSlug: attacker.tenant.slug,
      fromAddress: 'attacker@relay.test',
      dmarc: 'pass',
    });

    const boundary = '----swenllyRedTeamAtt';
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(payload)) {
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`),
      );
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="attachment-1"; filename="../../etc/passwd"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n` +
          `token=${victim.file.request_token}\nslug=${victim.tenant.slug}\n\r\n`,
      ),
    );
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/mailgun/inbound',
      payload: Buffer.concat(parts),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await testPool().query<{ file_id: string; requester_address: string }>(
      'SELECT file_id, requester_address FROM deliveries',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.file_id).toBe(attacker.file.id);
    expect(rows[0]?.requester_address).toBe('attacker@relay.test');
  });

  // ---------------------------------------------------------------- 401 leaks nothing
  it('BLOCKED: a 401 writes nothing at all — no inbound_messages, no deliveries, no jobs', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'nowrite@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'attacker@relay.test',
      dmarc: 'pass',
      signatureOverride: '00'.repeat(32),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/mailgun/inbound',
      payload: new URLSearchParams(payload as Record<string, string>).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('');

    const counts = await testPool().query<{ n: number }>(
      `SELECT (SELECT count(*) FROM inbound_messages)
             + (SELECT count(*) FROM deliveries)
             + (SELECT count(*) FROM jobs WHERE kind = 'delivery.fulfill') AS n`,
    );
    expect(Number(counts.rows[0]?.n)).toBe(0);
  });
});
