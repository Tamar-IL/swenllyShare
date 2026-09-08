import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { buildSignedWebhookPayload } from '../setup/webhook.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';

/**
 * RED TEAM — what actually happens when a file expires (AC-U4) and when retention
 * windows elapse (architecture.md §10).
 *
 * The request-time checks (pipeline gate 9, `/s/:slug`) are the "belt". The "braces" —
 * actually revoking the Zoho public link and the Drive permissions — live in the
 * `file.expire` job. Grepping the source: **no production code path ever enqueues
 * `file.expire`, `staging.purge` or `inbound.purge`.** The only `jobs.enqueue` calls for
 * those kinds are inside the tests that assert the handlers work. A handler that is never
 * scheduled is not a control.
 */
describe.skipIf(!hasTestDatabase())('RED TEAM — expiry revocation and retention jobs', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  // ---------------------------------------------------------------- RT-50
  it('RT-50: passing expires_at must revoke the Zoho public link (the shipping default distribution link)', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'exp-zoho@example.com');
    expect(file.zoho_link_id).toBeTruthy();

    await files.updateSettings(container.pool, tenant.id, file.id, {
      expiresAt: new Date(container.fakes.clock.now().getTime() + 60_000),
    });
    container.fakes.clock.advance(24 * 60 * 60_000);
    await runPendingJobs(container);

    // AC-U4: "after the set window, the distribution link ... no longer grant[s] access".
    // With BRANDED_PAGE_ENABLED off (the shipping default, AC-U2) the distribution link
    // IS the raw Zoho link — nothing in front of it to check expiry.
    expect(container.fakes.fileStore.links.get(file.zoho_link_id!)?.revoked).toBe(true);
  });

  it('RT-51: passing expires_at must revoke Drive permissions already granted', async () => {
    const container = buildTestContainer({ ATTACH_LIMIT_BYTES: 1 });
    const { tenant, file } = await createTenantWithReadyFile(container, 'exp-drive@example.com', {
      content: 'a much larger payload than the attach limit',
    });

    await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'requester@relay.test',
        dmarc: 'pass',
      }),
    );
    await runPendingJobs(container);
    const sent = container.fakes.outboundMail.sent.at(-1);
    const driveFileId = /file\/d\/([^/]+)\/view/.exec(sent?.text ?? '')?.[1];
    expect(driveFileId).toBeTruthy();
    expect(container.fakes.driveShare.permissionCount(driveFileId!)).toBe(1);

    await files.updateSettings(container.pool, tenant.id, file.id, {
      expiresAt: new Date(container.fakes.clock.now().getTime() + 60_000),
    });
    container.fakes.clock.advance(24 * 60 * 60_000);
    await runPendingJobs(container);

    expect(container.fakes.driveShare.permissionCount(driveFileId!)).toBe(0);
  });

  it('RT-52: setting an expiry must schedule the `file.expire` job', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'exp-sched@example.com');
    await files.updateSettings(container.pool, tenant.id, file.id, {
      expiresAt: new Date(container.fakes.clock.now().getTime() + 60_000),
    });

    const { rows } = await testPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM jobs WHERE kind = 'file.expire'`,
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------- RT-53
  it('RT-53: raw inbound payloads must actually be purged past RAW_PAYLOAD_RETENTION_DAYS', async () => {
    const container = buildTestContainer({ RAW_PAYLOAD_RETENTION_DAYS: 7 });
    const { tenant, file } = await createTenantWithReadyFile(container, 'purge@example.com');

    await container.services.requestPipeline.handleWebhook(
      buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'requester@relay.test',
        dmarc: 'pass',
        bodyPlain: 'personal content that should not survive retention',
      }),
    );
    // Fast-forward the retention deadline the way 8 days of wall clock would.
    await testPool().query(`UPDATE inbound_messages SET purge_after = now() - interval '1 day'`);

    await runPendingJobs(container);

    const { rows } = await testPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inbound_messages WHERE raw_payload IS NOT NULL`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('RT-54: staged blobs past the retention window must actually be purged', async () => {
    const container = buildTestContainer({ ATTACH_LIMIT_BYTES: 1, STAGING_RETENTION_HOURS: 1 });
    const { tenant, file } = await createTenantWithReadyFile(container, 'stage@example.com', {
      content: 'bytes larger than the attach limit stay staged for no reason',
    });
    expect(file.staging_blob_id).toBeTruthy();
    await testPool().query(`UPDATE files SET created_at = now() - interval '30 days'`);

    await runPendingJobs(container);

    const after = await files.findById(container.pool, tenant.id, file.id);
    expect(after?.staging_blob_id).toBeNull();
  });

  // ---------------------------------------------------------------- blocked
  it('BLOCKED: the branded page and its download both refuse an expired file', async () => {
    const container = buildTestContainer({ BRANDED_PAGE_ENABLED: true });
    const { buildApp } = await import('../../src/app.js');
    const app = await buildApp({ container });
    const { tenant, file } = await createTenantWithReadyFile(container, 'exp-page@example.com');

    await files.updateSettings(container.pool, tenant.id, file.id, {
      expiresAt: new Date(container.fakes.clock.now().getTime() + 60_000),
    });
    container.fakes.clock.advance(10 * 60_000);

    const page = await app.inject({ method: 'GET', url: `/s/${file.public_slug}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('workdrive.zohoexternal.com');

    const dl = await app.inject({ method: 'GET', url: `/s/${file.public_slug}/download` });
    expect(dl.statusCode).toBe(410);
  });

  it('BLOCKED: the `file.expire` handler itself works when it IS scheduled', async () => {
    // The handler is correct; only its scheduling is missing. Pinned so a fix for RT-50
    // is understood as "schedule it", not "rewrite it".
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'exp-manual@example.com');
    const { jobs } = await import('../../src/db/repositories/jobs.js');
    await jobs.enqueue(container.pool, {
      kind: 'file.expire',
      payload: { tenantId: tenant.id, fileId: file.id },
    });
    await runPendingJobs(container);
    expect(container.fakes.fileStore.links.get(file.zoho_link_id!)?.revoked).toBe(true);
    expect((await files.findById(container.pool, tenant.id, file.id))?.status).toBe('expired');
  });
});
