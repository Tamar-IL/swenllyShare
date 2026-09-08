import { describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import { signInAsNewTenant, getCsrfToken, CookieJar } from '../setup/http.js';
import { buildApp } from '../../src/app.js';
import { files } from '../../src/db/repositories/files.js';
import { fileAllowlist } from '../../src/db/repositories/file-allowlist.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';

/**
 * Regression cases from the QA pass on the sender app + upload + links + settings +
 * branded page (docs/qa/qa-report-sender-app.md). Each `it.fails` below reproduces a real
 * bug found during that pass and is pinned here so a fix flips it to a normal passing
 * test (remove `.fails` when fixed) instead of the bug silently coming back.
 */
describe.skipIf(!hasTestDatabase())('QA regressions — sender app', () => {
  it.fails(
    'BUG (Medium): POST /files/:id/delete for another tenant\'s file falsely "succeeds" ' +
      '(302, same as a real delete) instead of the 404 every other tenant-scoped route in ' +
      'files.ts returns for a cross-tenant id -- src/http/routes/files.ts ~L206-214, the ' +
      "route ignores FilesService.deleteFile()'s undefined-means-not-found return value",
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

  it.fails(
    'BUG (Medium): a settings save with one invalid allowlist pattern partially commits ' +
      '(displayName/expiry/allowlistMode ARE saved) before the allowlist-pattern validation ' +
      'throws and the allowlist itself is left unwritten -- src/domain/settings.ts ' +
      'updateSettings(): files.updateSettings() commits before validatePattern() can throw',
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

  it.fails(
    'BUG (Low): formatByteCeiling() renders "0MB" for a MAX_UPLOAD_BYTES under 1MB -- ' +
      'src/lib/presentation.ts formatByteCeiling() has no KB tier, unlike the client-side ' +
      'humanSize() in src/public/island.js which formats the same value correctly as "2KB"',
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

  it.fails(
    'BUG (Low/Medium): the sign-in rate limit (RATE_MAGICLINK_PER_HOUR) is keyed by IP only ' +
      '-- architecture.md §8 documents it as "per IP and per email" but src/app.ts registers ' +
      '@fastify/rate-limit with no keyGenerator, so requests for DIFFERENT emails from the ' +
      'same IP share one bucket: a burst of sign-in attempts for one address exhausts the ' +
      'budget for every other sender behind the same IP/NAT for up to an hour',
    async () => {
      await truncateAll();
      const container = buildTestContainer({ RATE_MAGICLINK_PER_HOUR: 2 });
      const app = await buildApp({ container });

      const post = (email: string) =>
        app.inject({
          method: 'POST',
          url: '/signin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams({ email }).toString(),
        });

      const r1 = await post('sender-a@example.com');
      const r2 = await post('sender-b@example.com'); // different email, same "IP" (app.inject)
      const r3 = await post('sender-c@example.com'); // a THIRD, never-before-seen email

      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      // What SHOULD happen if the limit were truly per-email as documented: a brand-new
      // email address should not be blocked by another address's requests. Today it is.
      expect(r3.statusCode).toBe(200);
    },
  );

  it.fails(
    'BUG (High): GET /api/files/:id/deliveries?since=<cursor> re-returns the SAME row the ' +
      'cursor was derived from, because the cursor is a millisecond-precision ' +
      'Date#toISOString() while `deliveries.created_at` is microsecond-precision ' +
      'timestamptz -- `created_at > since` (src/db/repositories/deliveries.ts listForFile) ' +
      'stays true for that row forever. In the running app (island.js poll every 5s, ' +
      'the UX brief\'s "load-bearing trust mechanism") this duplicates the most recent ' +
      'delivery into a new row on every single poll tick for as long as the per-file page ' +
      'stays open and no newer delivery arrives -- confirmed via Playwright: one seeded ' +
      'delivery became 4 DOM rows after three 5s poll cycles',
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

      const row = await container.pool.query<{ created_at: Date }>(
        `INSERT INTO deliveries (tenant_id, file_id, requester_address, mechanism, dmarc, outcome, completed_at)
         VALUES ($1, $2, 'lonewatcher@gmail.com', 'attachment', 'pass', 'sent', now())
         RETURNING created_at`,
        [tenant.id, file.id],
      );
      const createdAt = row.rows[0]!.created_at;
      // This is exactly what files.ts's own `deliverySinceIso` and island.js's own
      // `since = data.items[0].at` do: serialize the timestamp via toISOString().
      const cursor = createdAt.toISOString();

      const res = await app.inject({
        method: 'GET',
        url: `/api/files/${file.id}/deliveries?since=${encodeURIComponent(cursor)}`,
        headers: { cookie: jar.header() },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: unknown[] };
      // What SHOULD happen: a cursor derived from this row's own timestamp should never
      // return that same row again. Today it does.
      expect(body.items).toHaveLength(0);
    },
  );
});
