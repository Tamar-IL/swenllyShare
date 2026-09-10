import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import net from 'node:net';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { hasTestDatabase, testPool } from '../setup/db.js';
import { killChildOnFailedReadiness } from './support/boot-process.js';

/**
 * Bug 7 (docs/qa/qa-report-sender-app.md: "no browser harness") — the one real-Chromium,
 * real-server, real-DB smoke test in this repo. Everything else (unit/integration) talks
 * to `app.inject()` or a fake port directly; this is the only place that actually renders
 * a page, runs `island.js`, and checks pixels/computed styles. Deliberately narrow: one
 * long happy-path flow through the product, not a matrix — that's what the unit/
 * integration suites are for. Gated on `E2E=1` (see vitest.config.ts: the whole `e2e`
 * project only exists in the config when that's set) — never part of a plain `pnpm test`.
 */
const E2E = process.env.E2E === '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
  fn: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs?: number; message: string },
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + opts.timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${opts.timeoutMs}ms waiting for: ${opts.message}` +
          (lastErr ? ` (last error: ${String(lastErr)})` : ''),
      );
    }
    await sleep(intervalMs);
  }
}

/** Binds an ephemeral port and immediately frees it — a small TOCTOU race (something else
 * could grab it before the child binds) is an acceptable tradeoff for a local/CI smoke
 * test, and far simpler than teaching `src/server.ts` a "print your bound port" mode. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('failed to allocate an ephemeral port')));
      }
    });
  });
}

/** `/opt/pw-browsers` (see `PLAYWRIGHT_BROWSERS_PATH`) is where this environment's
 * Chromium build actually lives — `playwright-core` alone ships no browser binary of its
 * own. Falls through to letting `chromium.launch()` try its own resolution (which will
 * throw a clear "browser not found" error) if neither candidate exists, rather than
 * hard-failing here with a less useful message. */
function resolveChromiumExecutable(): string | undefined {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const candidate = path.join(browsersPath, 'chromium');
  if (existsSync(candidate)) return candidate;
  if (existsSync('/opt/pw-browsers/chromium')) return '/opt/pw-browsers/chromium';
  return undefined;
}

type SpawnedApp = ChildProcessByStdio<null, Readable, Readable>;

interface AppHandle {
  child: SpawnedApp;
  baseUrl: string;
  stdout: () => string;
  stop: () => Promise<void>;
}

/** Boots the real app as a child process (`tsx src/server.ts`) on a random port, against
 * the test database, with fake adapters + the worker loop enabled — exactly the shape a
 * developer runs locally, just non-interactively. `NODE_ENV` is left at its `development`
 * default deliberately: that's what makes `COOKIE_SECURE` default to `false`
 * (`src/config.ts`), which the session/CSRF cookies need to survive a plain-`http://`
 * Chromium session against 127.0.0.1. */
async function bootApp(databaseUrl: string): Promise<AppHandle> {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let stdoutBuf = '';
  const child = spawn(TSX_BIN, ['src/server.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: baseUrl,
      DATABASE_URL: databaseUrl,
      INBOUND_DOMAIN: 'e2e.swenlly.test',
      SESSION_SECRET: 'e2e-smoke-test-session-secret-at-least-32-chars-long',
      ADAPTERS: 'fake',
      WORKER_ENABLED: 'true',
      BRANDED_PAGE_ENABLED: 'true',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
  });

  let exited: { code: number | null } | undefined;
  child.on('exit', (code) => {
    exited = { code };
  });

  // Fix pass 8 (code-review.md polish-pass finding 4): a failed readiness wait (bad
  // DATABASE_URL, port collision, a genuine boot regression) used to propagate straight
  // out of `bootApp` with `child` never killed — this caller's `app = await
  // bootApp(...)` in `beforeAll` then never completed, so no `AppHandle`/pid survived
  // for `afterAll` to clean up, leaking the spawned process for the CI run's lifetime.
  await killChildOnFailedReadiness(child, () =>
    waitForCondition(
      async () => {
        if (exited) {
          throw new Error(`app process exited early (code ${exited.code}):\n${stdoutBuf}`);
        }
        try {
          const res = await fetch(`${baseUrl}/healthz`);
          return res.ok;
        } catch {
          return false;
        }
      },
      { timeoutMs: 20_000, intervalMs: 200, message: `app to boot on ${baseUrl}` },
    ),
  );

  return {
    child,
    baseUrl,
    stdout: () => stdoutBuf,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        // Belt-and-braces: don't let a stuck child hang the test run's teardown.
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 5_000).unref();
      }),
  };
}

function extractMagicLink(stdout: string, email: string): string | undefined {
  // FakeOutboundMail (src/adapters/mailgun/fake.ts) prints exactly this line for every
  // send; matching on the recipient keeps this correct even if a later assertion in the
  // same run triggers a second sign-in email.
  const re = new RegExp(
    `\\[dev\\] magic sign-in link for ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (\\S+)`,
  );
  const match = re.exec(stdout);
  return match?.[1];
}

describe.skipIf(!E2E)('E2E smoke — real browser, real server, real DB', () => {
  describe.skipIf(!hasTestDatabase())('full sender-app flow', () => {
    let app: AppHandle;
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let uploadDir: string;
    let uploadFilePath: string;
    const email = `qa-e2e-${Date.now()}@example.com`;

    beforeAll(async () => {
      // Start from an empty database — a stray row from a previous local run must never
      // make this test's "empty state" or "no duplicate row" assertions pass by accident.
      await testPool().query(
        `TRUNCATE TABLE deliveries, drive_copies, file_allowlist, files, inbound_messages,
                jobs, magic_link_tokens, rate_limit_counters, sessions, tenants
         RESTART IDENTITY CASCADE`,
      );
      // Reuse whichever database `testPool()` actually resolved to (plain `TEST_DATABASE_URL`,
      // or, with `TEST_DB_PER_RUN=1`, this run's private one) — pool.options.connectionString
      // is the one source of truth so the app-under-test and this file's own assertions can
      // never end up looking at two different databases.
      const connectionString = testPool().options.connectionString;
      if (!connectionString) throw new Error('testPool() has no connectionString to reuse');
      app = await bootApp(connectionString);

      const executablePath = resolveChromiumExecutable();
      browser = await chromium.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox'],
      });
      context = await browser.newContext();
      // http://127.0.0.1 is a Chromium "potentially trustworthy" origin, so `island.js`'s
      // copy-to-clipboard takes the `navigator.clipboard` branch (not the
      // `execCommand` fallback) even without TLS — it needs this permission granted.
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: app.baseUrl,
      });
      page = await context.newPage();

      uploadDir = await mkdtemp(path.join(tmpdir(), 'swenlly-e2e-'));
      uploadFilePath = path.join(uploadDir, 'smoke-test-file.bin');
      await writeFile(uploadFilePath, Buffer.alloc(1024, 'e'));
    }, 30_000);

    afterAll(async () => {
      // Fix pass 8 (code-review.md polish-pass finding 4): each cleanup step is
      // independent of the others' success — a plain sequential `await` chain meant one
      // failing step (e.g. `context.close()` throwing) skipped every step after it,
      // including `app?.stop()`, the ONE call that actually kills the spawned child
      // process. `.catch()` on each keeps `app?.stop()` (and the temp-dir removal)
      // reachable regardless of what happened earlier in this hook.
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      await app?.stop().catch(() => {});
      if (uploadDir) await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    });

    it('sign-in, upload, per-file page, copy, settings, deliveries, branded page', async () => {
      // --- Sign-in via the fake magic link -------------------------------------
      await page.goto(`${app.baseUrl}/signin`);
      await page.fill('#email', email);
      await Promise.all([
        page.waitForSelector('p.signin-card__message', { timeout: 15_000 }),
        page.click('button[type="submit"]'),
      ]);

      let magicLink: string | undefined;
      await waitForCondition(
        async () => {
          magicLink = extractMagicLink(app.stdout(), email);
          return Boolean(magicLink);
        },
        { timeoutMs: 10_000, intervalMs: 200, message: 'the fake magic-link email to be "sent"' },
      );
      expect(magicLink).toBeTruthy();

      // `goto` already waits through the callback's redirect to /files (default
      // waitUntil: 'load'), so `page.url()` is already settled here — this is a
      // (generously timed) belt-and-braces check, not the thing doing the waiting.
      await page.goto(magicLink!);
      await page.waitForURL(/\/files$/, { timeout: 20_000 });

      // --- Empty state ----------------------------------------------------------
      await expect
        .poll(() => page.locator('.empty-state__headline').textContent())
        .toBe('עדיין לא העלית קובץ');

      // --- Upload a 1KB file ------------------------------------------------------
      await page.goto(`${app.baseUrl}/files/new`);
      await page.waitForSelector('#file-input', { timeout: 15_000 });
      await page.setInputFiles('#file-input', uploadFilePath);
      // Not just /\/files\/[^/?#]+$/ — that also matches the /files/new page we're
      // already on. island.js navigates to /files/<uuid> once the upload XHR succeeds.
      await page.waitForURL(
        (url) => /^\/files\/[^/]+$/.test(url.pathname) && url.pathname !== '/files/new',
        { timeout: 20_000 },
      );
      const fileUrl = new URL(page.url());
      const fileId = fileUrl.pathname.split('/').filter(Boolean).pop();
      expect(fileId).toBeTruthy();

      // --- Status polls to ready: both artifact cards appear enabled -------------
      await waitForCondition(
        async () => {
          const cls = await page.locator('.artifact-card--dist').getAttribute('class');
          const hasValue =
            (await page.locator('.artifact-card--dist .artifact-card__value').count()) > 0;
          return Boolean(cls) && !cls!.includes('is-disabled') && hasValue;
        },
        { timeoutMs: 30_000, intervalMs: 500, message: 'the file to finish publishing (ready)' },
      );
      const distClass = await page.locator('.artifact-card--dist').getAttribute('class');
      expect(distClass).not.toMatch(/is-disabled/);
      const emailClass = await page.locator('.artifact-card--email').getAttribute('class');
      expect(emailClass).not.toMatch(/is-disabled/);

      // --- The email card's mailto address carries the request token ------------
      const { rows: fileRows } = await testPool().query<{
        request_token: string;
        tenant_id: string;
        public_slug: string;
        zoho_public_link: string | null;
        zoho_resource_id: string | null;
      }>(
        `SELECT request_token, tenant_id, public_slug, zoho_public_link, zoho_resource_id
           FROM files WHERE id = $1`,
        [fileId],
      );
      const fileRow = fileRows[0];
      expect(fileRow).toBeTruthy();
      const mailtoText = await page
        .locator('.artifact-card--email .artifact-card__value')
        .textContent();
      expect(mailtoText?.toLowerCase()).toContain(fileRow!.request_token.toLowerCase());

      // --- Copy button swaps to "הועתק" -------------------------------------------
      const copyBtn = page.locator('.artifact-card--dist .copy-btn');
      await copyBtn.click();
      await waitForCondition(async () => (await copyBtn.getAttribute('aria-label')) === 'הועתק', {
        timeoutMs: 3_000,
        message: 'the copy button aria-label to become "הועתק"',
      });

      // --- Settings save round-trips ----------------------------------------------
      const newDisplayName = `e2e-renamed-${Date.now()}`;
      await page.fill('#displayName', newDisplayName);
      await Promise.all([
        page.waitForURL(/[?&]flash=saved\b/, { timeout: 20_000 }),
        page.click('.settings-section button[type="submit"]'),
      ]);
      expect(await page.locator('#displayName').inputValue()).toBe(newDisplayName);
      await expect.poll(() => page.locator('.flash-banner').textContent()).toBe('ההגדרות נשמרו.');

      // --- No blank band above the header (QA report Bug 7) ------------------------
      // A string, not a closure: this file's tsconfig has no "dom" lib (it's Node-only
      // otherwise), so a `() => document...` arrow here wouldn't typecheck even though
      // it only ever runs inside the page.
      const headerTop = await page.evaluate<number | null>(
        "document.querySelector('header') ? document.querySelector('header').getBoundingClientRect().top : null",
      );
      expect(headerTop).toBe(0);

      // --- Deliveries: seed one row via SQL, poll without duplicating (Bug 1) -----
      await testPool().query(
        `INSERT INTO deliveries (tenant_id, file_id, requester_address, mechanism, outcome)
           VALUES ($1, $2, 'requester@example.com', 'attachment', 'sent')`,
        [fileRow!.tenant_id, fileId],
      );
      await waitForCondition(
        async () => (await page.locator('#deliveries-tbody tr').count()) === 1,
        { timeoutMs: 8_000, intervalMs: 500, message: 'the seeded delivery to appear once' },
      );
      // island.js polls every 5s — wait a further two cycles and confirm the row is
      // still exactly one (this is precisely the shape of QA report Bug 1).
      await sleep(11_000);
      expect(await page.locator('#deliveries-tbody tr').count()).toBe(1);

      // --- Resend button appears on a row that only ever arrived via polling (fix pass
      // 8, code-review.md polish-pass finding 3) --------------------------------------
      await testPool().query(
        `INSERT INTO deliveries (tenant_id, file_id, requester_address, mechanism, outcome)
           VALUES ($1, $2, 'failed-requester@example.com', 'attachment', 'failed')`,
        [fileRow!.tenant_id, fileId],
      );
      await waitForCondition(
        async () => (await page.locator('#deliveries-tbody tr').count()) === 2,
        { timeoutMs: 8_000, intervalMs: 500, message: 'the seeded failed delivery to appear' },
      );
      const resendForms = page.locator('#deliveries-tbody form[action*="/deliveries/"]');
      await expect.poll(() => resendForms.count()).toBe(1);
      expect(await resendForms.first().getAttribute('action')).toMatch(/\/deliveries\/.+\/resend$/);

      // --- Branded page: "Swenlly" present, raw Zoho link never leaked -------------
      const sharePage = await context.newPage();
      await sharePage.goto(`${app.baseUrl}/s/${fileRow!.public_slug}`);
      const html = await sharePage.content();
      expect(html).toContain('Swenlly');
      if (fileRow!.zoho_public_link) expect(html).not.toContain(fileRow!.zoho_public_link);
      if (fileRow!.zoho_resource_id) expect(html).not.toContain(fileRow!.zoho_resource_id);
      await sharePage.close();
    }, 120_000);
  });
});
