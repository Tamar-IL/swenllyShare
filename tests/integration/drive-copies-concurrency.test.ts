import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { tenants } from '../../src/db/repositories/tenants.js';
import { files } from '../../src/db/repositories/files.js';
import { driveCopies } from '../../src/db/repositories/drive-copies.js';
import { opaqueToken } from '../../src/lib/base32.js';

describe.skipIf(!hasTestDatabase())(
  'drive_copies intent uniqueness under concurrency (AC-E2)',
  () => {
    beforeEach(async () => {
      await truncateAll();
    });

    it('20 concurrent insertIntent calls for the same (tenant,file,seq) yield exactly one row', async () => {
      const pool = testPool();
      const tenant = await tenants.createIfNotExists(pool, {
        email: 'concurrency@example.com',
        slug: 'concur',
      });
      const file = await files.create(pool, {
        tenantId: tenant.id,
        displayName: 'big.zip',
        originalName: 'big.zip',
        sizeBytes: 500_000_000,
        mime: 'application/zip',
        requestToken: opaqueToken(128),
        publicSlug: opaqueToken(128),
      });

      // Each call checks out its own connection from the pool (node-postgres does this
      // per-query when called on the Pool directly), so this genuinely exercises 20
      // distinct connections racing the same unique constraint, not one serialized client.
      const attempts = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          driveCopies.insertIntent(pool, {
            tenantId: tenant.id,
            fileId: file.id,
            intentSeq: 0,
            intentKey: `${tenant.id}:${file.id}:0:attempt-${i}`,
          }),
        ),
      );

      const winners = attempts.filter((row) => row !== undefined);
      expect(winners).toHaveLength(1);

      const { rows } = await pool.query(
        'SELECT count(*)::int AS count FROM drive_copies WHERE tenant_id = $1 AND file_id = $2 AND intent_seq = 0',
        [tenant.id, file.id],
      );
      expect(rows[0].count).toBe(1);

      // The losers can recover the winner's row by re-reading — this is the pairing
      // between the unique constraint (idempotency) and the caller's advisory lock
      // (mutual exclusion) described in architecture.md §5.
      const reread = await driveCopies.getBySeq(pool, tenant.id, file.id, 0);
      expect(reread).toBeDefined();
      expect(reread?.id).toBe(winners[0]!.id);
    });

    it('distinct intent_seq values for the same (tenant,file) all succeed independently', async () => {
      const pool = testPool();
      const tenant = await tenants.createIfNotExists(pool, {
        email: 'seqs@example.com',
        slug: 'seqsslug',
      });
      const file = await files.create(pool, {
        tenantId: tenant.id,
        displayName: 'f.zip',
        originalName: 'f.zip',
        sizeBytes: 1,
        mime: 'application/zip',
        requestToken: opaqueToken(128),
        publicSlug: opaqueToken(128),
      });

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, seq) =>
          driveCopies.insertIntent(pool, {
            tenantId: tenant.id,
            fileId: file.id,
            intentSeq: seq,
            intentKey: `${tenant.id}:${file.id}:${seq}`,
          }),
        ),
      );
      expect(results.every((r) => r !== undefined)).toBe(true);

      const all = await driveCopies.listForFile(pool, tenant.id, file.id);
      expect(all).toHaveLength(5);
    });
  },
);
