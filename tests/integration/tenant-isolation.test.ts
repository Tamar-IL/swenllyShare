import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { tenants } from '../../src/db/repositories/tenants.js';
import { files } from '../../src/db/repositories/files.js';
import { opaqueToken } from '../../src/lib/base32.js';

describe.skipIf(!hasTestDatabase())('tenant scoping (AC-A3)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('tenant B cannot read tenant A file by id through the tenant-scoped repository', async () => {
    const pool = testPool();
    const tenantA = await tenants.createIfNotExists(pool, {
      email: 'a@example.com',
      slug: 'tenanta',
    });
    const tenantB = await tenants.createIfNotExists(pool, {
      email: 'b@example.com',
      slug: 'tenantb',
    });

    const file = await files.create(pool, {
      tenantId: tenantA.id,
      displayName: 'secret.pdf',
      originalName: 'secret.pdf',
      sizeBytes: 1024,
      mime: 'application/pdf',
      requestToken: opaqueToken(128),
      publicSlug: opaqueToken(128),
    });

    // Owner reads fine.
    const asOwner = await files.findById(pool, tenantA.id, file.id);
    expect(asOwner?.id).toBe(file.id);

    // Cross-tenant read returns nothing — not an error, not a leaked row.
    const asOther = await files.findById(pool, tenantB.id, file.id);
    expect(asOther).toBeUndefined();

    // Tenant B's own file list never contains tenant A's file.
    const listB = await files.list(pool, tenantB.id);
    expect(listB.find((f) => f.id === file.id)).toBeUndefined();
  });

  it('resolveByRequestToken and resolveBySlug are the only cross-tenant reads, and both return tenant_id', async () => {
    const pool = testPool();
    const tenantA = await tenants.createIfNotExists(pool, {
      email: 'c@example.com',
      slug: 'tenantc',
    });
    const requestToken = opaqueToken(128);
    const publicSlug = opaqueToken(128);

    const file = await files.create(pool, {
      tenantId: tenantA.id,
      displayName: 'report.pdf',
      originalName: 'report.pdf',
      sizeBytes: 2048,
      mime: 'application/pdf',
      requestToken,
      publicSlug,
    });

    const byToken = await files.resolveByRequestToken(pool, requestToken);
    expect(byToken?.id).toBe(file.id);
    expect(byToken?.tenant_id).toBe(tenantA.id);

    const bySlug = await files.resolveBySlug(pool, publicSlug);
    expect(bySlug?.id).toBe(file.id);
    expect(bySlug?.tenant_id).toBe(tenantA.id);

    // Unknown token/slug resolve to nothing, without disclosing which was tried.
    expect(await files.resolveByRequestToken(pool, opaqueToken(128))).toBeUndefined();
    expect(await files.resolveBySlug(pool, opaqueToken(128))).toBeUndefined();
  });

  it('one email is one tenant even under a concurrent sign-in race', async () => {
    const pool = testPool();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        tenants.createIfNotExists(pool, { email: 'Race@Example.com', slug: 'raceslug' }),
      ),
    );
    const ids = new Set(results.map((t) => t.id));
    expect(ids.size).toBe(1);

    const found = await tenants.findByEmail(pool, 'race@example.com');
    expect(found?.id).toBe([...ids][0]);
  });
});
