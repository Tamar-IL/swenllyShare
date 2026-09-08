import { describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { signInAsNewTenant, getCsrfToken, CookieJar } from '../setup/http.js';
import { buildApp } from '../../src/app.js';
import { files } from '../../src/db/repositories/files.js';
import { fileAllowlist } from '../../src/db/repositories/file-allowlist.js';

/**
 * Regression cases from the QA pass on the sender app + upload + links + settings +
 * branded page (docs/qa/qa-report-sender-app.md). All 8 bugs found in that pass are fixed
 * as of this file's current state; each case below is pinned as a normal passing test
 * (was `it.fails` while the bug was still open) so a regression on any of them fails the
 * suite instead of coming back silently.
 */
describe.skipIf(!hasTestDatabase())('QA regressions — sender app', () => {
  it(
    "FIXED (was Medium): POST /files/:id/delete for another tenant's file now 404s, " +
      'matching every other tenant-scoped route in files.ts, instead of falsely ' +
      '"succeeding" (302) -- src/http/routes/files.ts checks FilesService.deleteFile()\'s ' +
      'undefined-means-not-found return value',
    async () => {
      await truncateAll();
      const container = buildTestContainer();
      const app = await buildApp({ container });
      const { tenant, file } = await createTenantWithReadyFile(
        container,
        'delete-owner@example.com',
      );
      const { cookieHeader: intruderCookie } = await signInAsNewTenant(
        container,
        'delete-intruder@example.com',
      );
      const jar = new CookieJar();
      jar.set('swy_sess', intruderCookie.split('=')[1]!);
      const csrfToken = await getCsrfToken(app, jar, '/files/new');

      const res = await app.inject({
        method: 'POST',
        url: `/files/${file.id}/delete`,
        headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: csrfToken }).toString(),
      });

      // This is the assertion a fix should satisfy: same 404 contract as GET/settings.
      expect(res.statusCode).toBe(404);

      // Underlying data is NOT actually damaged today (tenant_id scoping in the repository
      // protects it) -- confirmed separately so a fix to the route's status code doesn't
      // accidentally get "verified" against a data-loss regression instead.
      const stillThere = await files.findById(container.pool, tenant.id, file.id);
      expect(stillThere?.status).toBe('ready');
    },
  );

  it(
    'FIXED (was Medium): a settings save with one invalid allowlist pattern is now fully ' +
      'atomic -- validatePattern() runs (and can throw) BEFORE any write, and the two ' +
      'writes that do land (files.updateSettings + fileAllowlist.replaceAll) commit ' +
      'together in one transaction -- src/domain/settings.ts updateSettings()',
    async () => {
      await truncateAll();
      const container = buildTestContainer();
      const app = await buildApp({ container });
      const { tenant, file } = await createTenantWithReadyFile(
        container,
        'atomic-owner@example.com',
      );
      const jar = new CookieJar();
      const { cookieHeader } = await signInAsNewTenant(container, 'atomic-owner@example.com');
      jar.set('swy_sess', cookieHeader.split('=')[1]!);
      const csrfToken = await getCsrfToken(app, jar, `/files/${file.id}`);

      const res = await app.inject({
        method: 'POST',
        url: `/files/${file.id}/settings`,
        headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          _csrf: csrfToken,
          displayName: 'should-not-be-saved.pdf',
          expiryMode: 'none',
          allowlistMode: 'allowlist',
          allowlist: 'good@example.com\nNOT-A-VALID-PATTERN',
        }).toString(),
      });

      // The route currently renders a 200 error page rather than a redirect -- either way,
      // the whole submit is expected to be atomic: nothing should be persisted.
      expect(res.statusCode).not.toBe(302);

      const afterFailure = await files.findById(container.pool, tenant.id, file.id);
      // This is what SHOULD be true (and currently is not): the display name change from
      // the same rejected submit must not have been persisted either.
      expect(afterFailure?.display_name).toBe(file.display_name);

      const allowlistRows = await fileAllowlist.list(container.pool, tenant.id, file.id);
      expect(allowlistRows).toHaveLength(0);
    },
  );

  it(
    'FIXED (was Low): formatByteCeiling() now has a KB tier and renders "2KB" (not "0MB") ' +
      'for a MAX_UPLOAD_BYTES under 1MB, matching the client-side humanSize() in ' +
      'src/public/island.js -- src/lib/presentation.ts formatByteCeiling()',
    async () => {
      await truncateAll();
      const container = buildTestContainer({ MAX_UPLOAD_BYTES: 2000 });
      const app = await buildApp({ container });
      const { cookieHeader } = await signInAsNewTenant(container, 'ceiling@example.com');
      const jar = new CookieJar();
      jar.set('swy_sess', cookieHeader.split('=')[1]!);

      const res = await app.inject({
        method: 'GET',
        url: '/files/new',
        headers: { cookie: jar.header() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('0MB');
      expect(res.body).toContain('2KB');
    },
  );

  it(
    'FIXED (was Low/Medium): sign-in is now rate-limited per IP AND per email, matching ' +
      'architecture.md §8 -- src/http/routes/signin.ts keys the route-level limiter by ' +
      '(ip, email) so a burst for ONE address no longer exhausts the budget for every ' +
      'OTHER address behind the same IP/NAT; AuthService.requestMagicLink additionally ' +
      'enforces a genuinely IP-independent per-email cap on the Postgres sliding window',
    async () => {
      await truncateAll();
      const container = buildTestContainer({ RATE_MAGICLINK_PER_HOUR: 2 });
      const app = await buildApp({ container });

      const post = async (email: string, remoteAddress: string, jar: CookieJar) => {
        const csrfToken = await getCsrfToken(app, jar, '/signin', { remoteAddress });
        return app.inject({
          method: 'POST',
          url: '/signin',
          headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams({ _csrf: csrfToken, email }).toString(),
          remoteAddress,
        });
      };

      // Scenario A -- the exact collateral-damage bug the QA pass hit: three DIFFERENT
      // addresses, same shared IP. None should block another.
      const sharedIp = '203.0.113.10';
      const jarA = new CookieJar();
      const r1 = await post('sender-a@example.com', sharedIp, jarA);
      const r2 = await post('sender-b@example.com', sharedIp, jarA); // different email, same IP
      const r3 = await post('sender-c@example.com', sharedIp, jarA); // a THIRD, new email

      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      // A brand-new email address must not be blocked by another address's requests from
      // the same IP.
      expect(r3.statusCode).toBe(200);

      // Scenario B -- the per-IP dimension still works: repeating the SAME address from
      // the SAME IP past the cap is blocked (unchanged from the pre-existing behavior
      // pinned in tests/integration/inbound-rate-limits.test.ts). r1 above was request #1
      // for (sharedIp, sender-a); two more make #2 (still within the cap of 2) and #3
      // (exceeds it).
      const r1Repeat = await post('sender-a@example.com', sharedIp, jarA);
      expect(r1Repeat.statusCode).toBe(200);
      const r1Repeat2 = await post('sender-a@example.com', sharedIp, jarA);
      expect(r1Repeat2.statusCode).toBe(429);

      // Scenario C -- the per-email dimension: the SAME address requested from THREE
      // DIFFERENT IPs (so no single (ip,email) bucket ever exceeds the cap on its own)
      // is still capped once IN TOTAL it exceeds RATE_MAGICLINK_PER_HOUR. The response
      // stays 200 either way (no-enumeration, architecture.md §8) -- the cap is visible
      // in whether a magic-link email actually goes out.
      const targetEmail = 'victim@example.com';
      await post(targetEmail, '198.51.100.1', new CookieJar());
      await post(targetEmail, '198.51.100.2', new CookieJar());
      const rThirdIp = await post(targetEmail, '198.51.100.3', new CookieJar());
      expect(rThirdIp.statusCode).toBe(200);
      const mailsToVictim = container.fakes.outboundMail.sent.filter((m) => m.to === targetEmail);
      expect(mailsToVictim).toHaveLength(2); // the 3rd, from a 3rd distinct IP, was suppressed
    },
  );

  it(
    'FIXED (was High): GET /api/files/:id/deliveries?since=&sinceId= no longer re-returns ' +
      'the row the cursor was derived from. The bare timestamp half of the cursor is ' +
      'millisecond-precision (Date#toISOString()) while `deliveries.created_at` is ' +
      'microsecond-precision timestamptz, so a plain `created_at > since` stayed true for ' +
      'that row forever -- the fix is a `(created_at, id)` keyset: `sinceId` (the anchor ' +
      "row's own id) excludes it exactly, regardless of timestamp precision loss -- " +
      'src/db/repositories/deliveries.ts listForFile(), src/public/island.js poll()',
    async () => {
      await truncateAll();
      const container = buildTestContainer();
      const app = await buildApp({ container });
      const { tenant, file } = await createTenantWithReadyFile(
        container,
        'poll-cursor@example.com',
      );
      const { cookieHeader } = await signInAsNewTenant(container, 'poll-cursor@example.com');
      const jar = new CookieJar();
      jar.set('swy_sess', cookieHeader.split('=')[1]!);

      const row = await container.pool.query<{ id: string; created_at: Date }>(
        `INSERT INTO deliveries (tenant_id, file_id, requester_address, mechanism, dmarc, outcome, completed_at)
         VALUES ($1, $2, 'lonewatcher@gmail.com', 'attachment', 'pass', 'sent', now())
         RETURNING id, created_at`,
        [tenant.id, file.id],
      );
      const { id: deliveryId, created_at: createdAt } = row.rows[0]!;
      // This is exactly what files.ts's own `deliverySinceIso`/`deliverySinceId` and
      // island.js's own `since = data.items[0].at; sinceId = data.items[0].id;` do:
      // serialize the anchor row's timestamp (lossy) and id (exact) as the poll cursor.
      const cursor = createdAt.toISOString();

      const res = await app.inject({
        method: 'GET',
        url:
          `/api/files/${file.id}/deliveries` +
          `?since=${encodeURIComponent(cursor)}&sinceId=${encodeURIComponent(deliveryId)}`,
        headers: { cookie: jar.header() },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: unknown[] };
      // A cursor derived from this row's own timestamp+id must never return that same
      // row again.
      expect(body.items).toHaveLength(0);

      // A genuinely NEW delivery inserted after the cursor must still come through.
      await container.pool.query(
        `INSERT INTO deliveries (tenant_id, file_id, requester_address, mechanism, dmarc, outcome, completed_at)
         VALUES ($1, $2, 'second-watcher@gmail.com', 'attachment', 'pass', 'sent', now())`,
        [tenant.id, file.id],
      );
      const res2 = await app.inject({
        method: 'GET',
        url:
          `/api/files/${file.id}/deliveries` +
          `?since=${encodeURIComponent(cursor)}&sinceId=${encodeURIComponent(deliveryId)}`,
        headers: { cookie: jar.header() },
      });
      const body2 = res2.json() as { items: Array<{ address: string }> };
      expect(body2.items).toHaveLength(1);
      expect(body2.items[0]?.address).toBe('second-watcher@gmail.com');
    },
  );

  it(
    "FIXED (was Medium/Low): a deleted file's own page no longer shows its artifact " +
      "cards as fully active -- displayStatus === 'deleted' is now treated like " +
      "'expired' in the file-detail read model, so both artifact cards disable/warn " +
      'exactly like an expired file (UX brief: deleting is "equivalent to instant ' +
      'expiry") -- src/http/routes/files.ts GET /files/:id `isExpired`',
    async () => {
      await truncateAll();
      const container = buildTestContainer();
      const app = await buildApp({ container });
      const { file } = await createTenantWithReadyFile(container, 'deleted-view@example.com');
      const { cookieHeader } = await signInAsNewTenant(container, 'deleted-view@example.com');
      const jar = new CookieJar();
      jar.set('swy_sess', cookieHeader.split('=')[1]!);

      const deleteCsrf = await getCsrfToken(app, jar, `/files/${file.id}`);
      const deleteRes = await app.inject({
        method: 'POST',
        url: `/files/${file.id}/delete`,
        headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: deleteCsrf }).toString(),
      });
      expect(deleteRes.statusCode).toBe(302);

      const detailRes = await app.inject({
        method: 'GET',
        url: `/files/${file.id}`,
        headers: { cookie: jar.header() },
      });
      expect(detailRes.statusCode).toBe(200);
      // Status pill correctly said "deleted" even before this fix -- the bug was that
      // both artifact cards still rendered as fully live underneath it.
      expect(detailRes.body).toContain('artifact-card artifact-card--dist is-disabled');
      expect(detailRes.body).toContain('artifact-card artifact-card--email is-disabled');
    },
  );
});
