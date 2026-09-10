import { describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { files } from '../../src/db/repositories/files.js';
import { runPendingJobs } from '../../src/jobs/queue.js';

/**
 * Fix pass 8 (code-review.md "Polish pass review — 2026-09-10", confirmed-clean pin,
 * promoted from `tests/review/resend-respects-expiry-gate.probe.test.ts`): confirms
 * (positively — no bug found here) that `AuditService.resendDelivery`'s enqueued
 * `delivery.fulfill` job still runs `checkGatesOrTerminal`
 * (src/jobs/handlers/delivery-fulfill.ts) before sending anything, i.e. resend does NOT
 * bypass the expiry re-check just because the ORIGINAL delivery happened while the file
 * was still live. Permanent regression test guarding already-correct behavior.
 */
describe.skipIf(!hasTestDatabase())('resend respects the expiry gate at fulfill-time', () => {
  it('a resend of a failed delivery on a file that has since expired finalizes expired, not sent', async () => {
    await truncateAll();
    const container = buildTestContainer();
    const email = 'resend-expiry-gate@example.com';
    const { tenant, file } = await createTenantWithReadyFile(container, email);

    const original = await deliveries.insertTerminal(container.pool, {
      tenantId: tenant.id,
      fileId: file.id,
      requesterAddress: 'requester@example.com',
      outcome: 'failed',
      dmarc: 'pass',
    });

    // The file expires AFTER the original attempt but BEFORE the resend is fulfilled.
    await files.updateSettings(container.pool, tenant.id, file.id, {
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await container.services.audit.resendDelivery(tenant.id, file.id, original.id);
    expect(result.status).toBe('ok');

    await runPendingJobs(container);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id, { limit: 10 });
    const resent = rows.find((r) => r.id !== original.id)!;
    expect(resent.outcome).toBe('expired');
  });
});
