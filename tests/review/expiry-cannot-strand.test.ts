import { Readable } from 'node:stream';
import { describe, expect, it, beforeEach } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { signInAsNewTenant } from '../setup/http.js';
import { buildApp } from '../../src/app.js';
import { runPendingJobs, processNextJob, ensureSweepsScheduled } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';
import type { FileStorePort } from '../../src/ports/file-store.js';
import { PermanentError } from '../../src/ports/errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * CRITIC F-C (`docs/reviews/critic-report.md`), reproduced then fixed: with
 * `BRANDED_PAGE_ENABLED=false` (the shipping default), `FileStorePort.revokeLink` is the
 * ONLY thing enforcing AC-U4 on the raw-Zoho-link path. Before this fix, a permanently
 * failing `revokeLink` dead-lettered `file.expire` silently — no dead-letter hook existed
 * for that job kind, and `expiry.safety_sweep`'s plain `jobs.enqueue` no-op'd forever
 * against the still-present `dead` row (`ON CONFLICT ... DO NOTHING`), so the file stayed
 * `ready` past its own `expires_at` indefinitely, with the raw link still live and nothing
 * anywhere recording that anything was wrong.
 *
 * This is the critic's own re-check protocol item 3 ("can a permanently failing
 * `revokeLink` still strand a file silently") and its exact reproduction scenario:
 * revokeLink throws permanently -> after the sweep runs the file is expired, drive.revoke
 * jobs exist, `/readyz.strandedExpiries === 1`, and the expire job is pending again (not
 * stranded dead).
 */
describe.skipIf(!hasTestDatabase())(
  'CRITIC F-C: a permanently failing revokeLink cannot strand a file',
  () => {
    beforeEach(async () => {
      await truncateAll();
    });

    it('revokeLink throws permanently -> expired, drive.revoke enqueued, /readyz counts it, expire job pending again (not dead)', async () => {
      const container = buildTestContainer({ DEFAULT_EXPIRY_DAYS: 1, JOB_MAX_ATTEMPTS: 2 });
      const app = await buildApp({ container });
      const { tenantId } = await signInAsNewTenant(container, 'strand@example.com');

      const created = await container.services.files.createStaged({
        tenantId,
        stream: Readable.from(Buffer.from('bytes')),
        originalName: 'strand.pdf',
        mime: 'application/pdf',
      });
      await runPendingJobs(container);
      const file = (await files.findById(container.pool, tenantId, created.id))!;
      expect(file.status).toBe('ready');
      expect(file.zoho_link_id).toBeTruthy();

      // revokeLink always fails permanently — modeling the exact "guessed endpoint shape
      // rejects the call" scenario the critic reproduced (F-C, `src/adapters/zoho/real.ts`
      // is `@unverified-live`). Bound explicitly (not spread) — `FakeFileStore`'s methods
      // live on its prototype, not as own enumerable properties, so a plain
      // `{...real, revokeLink(...)}` would silently drop the rest (same pitfall noted in
      // tests/review/delivery-fulfill-sending-crash.test.ts).
      const real = container.ports.fileStore;
      const alwaysFailsRevoke: FileStorePort = {
        upload: real.upload.bind(real),
        createPublicLink: real.createPublicLink.bind(real),
        openDownload: real.openDownload.bind(real),
        delete: real.delete.bind(real),
        async revokeLink() {
          throw new PermanentError('Zoho WorkDrive API: HTTP 404 (guessed endpoint shape)');
        },
      };
      (container.ports as { fileStore: FileStorePort }).fileStore = alwaysFailsRevoke;

      // Advance past expires_at. Once the FakeClock is ahead of real wall-clock time,
      // `jobs.claimNext`'s `dueAsOf` (the LATER of the injected Clock and real time —
      // `src/db/repositories/jobs.ts`) makes every real-time backoff `jobs.fail()` computes
      // immediately due too, so a single `runPendingJobs` drain runs every retry attempt
      // back-to-back through to dead-letter, with no need to force `run_after` by hand
      // between attempts (unlike `tests/review/delete-during-publish.test.ts`'s pattern,
      // which advances no virtual clock and so DOES need that).
      container.fakes.clock.advance(2 * DAY_MS);
      await runPendingJobs(container);

      const deadJob = await testPool().query<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM jobs WHERE kind = 'file.expire' AND dedupe_key = $1`,
        [`expire:${file.id}`],
      );
      expect(deadJob.rows[0]?.status).toBe('dead');
      expect(deadJob.rows[0]?.attempts).toBe(container.config.JOB_MAX_ATTEMPTS);

      // The DB/Drive side is NOT blocked by the failing revoke: status flipped, and the
      // seq-0 Drive copy's revoke was enqueued — both happened BEFORE revokeLink was ever
      // attempted, and neither depends on it succeeding.
      const afterDeadLetter = await files.findById(container.pool, tenantId, file.id);
      expect(afterDeadLetter?.status).toBe('expired');
      const { rows: revokeJobs } = await testPool().query(
        `SELECT count(*)::int AS n FROM jobs WHERE kind = 'drive.revoke'`,
      );
      expect(revokeJobs[0].n).toBeGreaterThan(0);

      // The failure is recorded, not silent.
      expect(afterDeadLetter?.expiry_error).toBeTruthy();
      const readyzBefore = await app.inject({ method: 'GET', url: '/readyz' });
      expect(readyzBefore.json().strandedExpiries).toBe(1);

      // The sweep (belt-and-braces, F-5) reactivates the dead-lettered job instead of
      // leaving it permanently abandoned — checked by claiming ONLY the sweep job
      // (`processNextJob` with a narrow `kinds` list), not a full `runPendingJobs` drain,
      // which — for the same "virtual clock ahead of real time neutralizes backoff" reason
      // noted above — would otherwise immediately reclaim and re-exhaust the freshly
      // reactivated `file.expire` job's attempts too, right back to `dead`, before this
      // assertion ever got to observe the intermediate `pending` state.
      await ensureSweepsScheduled(container);
      await testPool().query(
        `UPDATE jobs SET run_after = now() WHERE kind = 'expiry.safety_sweep'`,
      );
      const sweptOne = await processNextJob(container, ['expiry.safety_sweep']);
      expect(sweptOne).toBe(true);

      const reactivated = await testPool().query<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM jobs WHERE kind = 'file.expire' AND dedupe_key = $1`,
        [`expire:${file.id}`],
      );
      expect(reactivated.rows[0]?.status).toBe('pending');
      expect(reactivated.rows[0]?.attempts).toBe(0);

      // Fixing the underlying failure and letting the reactivated job run for real clears
      // the stranding marker.
      (container.ports as { fileStore: FileStorePort }).fileStore = container.fakes.fileStore;
      const ranOnce = await processNextJob(container, ['file.expire']);
      expect(ranOnce).toBe(true);
      const recovered = await files.findById(container.pool, tenantId, file.id);
      expect(recovered?.status).toBe('expired');
      expect(recovered?.expiry_error).toBeNull();
      const readyzAfter = await app.inject({ method: 'GET', url: '/readyz' });
      expect(readyzAfter.json().strandedExpiries).toBe(0);
    });
  },
);
