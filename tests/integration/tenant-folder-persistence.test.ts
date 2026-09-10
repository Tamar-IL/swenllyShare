import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { signInAsNewTenant } from '../setup/http.js';
import { tenants } from '../../src/db/repositories/tenants.js';

/**
 * Fix pass 8 (docs/reviews/code-review.md, "Polish pass review — 2026-09-10" finding 2):
 * `FilesService.publishFile` now resolves a tenant's Zoho/Drive folder id under a
 * Postgres advisory lock (`swenlly.tenant-folder`) and persists it to
 * `tenants.zoho_folder_id`/`drive_folder_id` (migration 0007) the first time it's
 * needed, instead of relying solely on each adapter's private in-memory cache — which
 * is empty on every restart and has no cross-process lock. Replaces
 * `tests/review/tenant-folder-race.probe.test.ts` (deleted), whose two `it.fails` pins
 * demonstrated the bug directly against the bare Zoho adapter; these regression tests
 * instead exercise the actual fix at the layer it lives in (`FilesService` + real
 * Postgres), which is what a bare-adapter test cannot prove.
 */
describe.skipIf(!hasTestDatabase())(
  'tenant folder id persistence (FilesService.publishFile)',
  () => {
    it('8 concurrent first-time publishes for one tenant create exactly one folder per provider', async () => {
      await truncateAll();
      const container = buildTestContainer();
      const { tenantId } = await signInAsNewTenant(container, 'concurrent-folders@example.com');

      const N = 8;
      const fileIds: string[] = [];
      for (let i = 0; i < N; i += 1) {
        const created = await container.services.files.createStaged({
          tenantId,
          stream: Readable.from(Buffer.from(`content-${i}`)),
          originalName: `f${i}.pdf`,
          mime: 'application/pdf',
        });
        fileIds.push(created.id);
      }

      // Each `publishFile` call runs its own `withTransaction` (its own checked-out pool
      // connection) — `Promise.all` genuinely races 8 separate Postgres sessions against
      // the same `swenlly.tenant-folder` advisory-lock key, not just 8 interleaved
      // promises on one connection.
      const published = await Promise.all(
        fileIds.map((id) => container.services.files.publishFile(tenantId, id)),
      );
      expect(published.every((f) => f.status === 'ready')).toBe(true);

      expect(container.fakes.fileStore.folders.size).toBe(1);
      expect(container.fakes.driveShare.folders.size).toBe(1);

      const tenant = await tenants.findById(container.pool, tenantId);
      expect(tenant?.zoho_folder_id).toBeTruthy();
      expect(tenant?.drive_folder_id).toBeTruthy();
      expect(tenant?.zoho_folder_id).toBe(container.fakes.fileStore.folders.get(tenantId));
      expect(tenant?.drive_folder_id).toBe(container.fakes.driveShare.folders.get(tenantId));
    });

    it('a process restart (fresh adapter instances) reuses the tenant folder id persisted in the DB', async () => {
      await truncateAll();
      const container1 = buildTestContainer();
      const { tenantId } = await signInAsNewTenant(container1, 'restart-folders@example.com');

      const file1 = await container1.services.files.createStaged({
        tenantId,
        stream: Readable.from(Buffer.from('one')),
        originalName: 'one.pdf',
        mime: 'application/pdf',
      });
      await container1.services.files.publishFile(tenantId, file1.id);

      const afterFirst = await tenants.findById(container1.pool, tenantId);
      expect(afterFirst?.zoho_folder_id).toBeTruthy();
      expect(afterFirst?.drive_folder_id).toBeTruthy();

      // Simulate a process restart: a brand-new container against the SAME database — its
      // `FakeFileStore`/`FakeDriveShare` are fresh instances with empty in-memory caches,
      // exactly like a real adapter after a real restart.
      const container2 = buildTestContainer({}, container1.pool);
      const file2 = await container2.services.files.createStaged({
        tenantId,
        stream: Readable.from(Buffer.from('two')),
        originalName: 'two.pdf',
        mime: 'application/pdf',
      });
      await container2.services.files.publishFile(tenantId, file2.id);

      // Reused the SAME ids the first instance created — never minted fresh ones.
      expect(container2.fakes.fileStore.folders.get(tenantId)).toBe(afterFirst!.zoho_folder_id);
      expect(container2.fakes.driveShare.folders.get(tenantId)).toBe(afterFirst!.drive_folder_id);
      expect(container2.fakes.fileStore.folders.size).toBe(1);
      expect(container2.fakes.driveShare.folders.size).toBe(1);

      const afterSecond = await tenants.findById(container1.pool, tenantId);
      expect(afterSecond?.zoho_folder_id).toBe(afterFirst?.zoho_folder_id);
      expect(afterSecond?.drive_folder_id).toBe(afterFirst?.drive_folder_id);
    });
  },
);
