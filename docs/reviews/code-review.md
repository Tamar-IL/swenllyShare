# Code Review — Swenlly System 2, HEAD vs `ea34ab2`

**Reviewer:** code-reviewer · **Scope:** full product diff (`git diff ea34ab2..HEAD`), fresh eyes.
**Excluded (per instructions):** appsec-review.md items 3–7 in `src/adapters/zoho/real.ts`,
`src/domain/{files,settings,reply-composer}.ts`, `src/db/pool.ts` — a backend engineer is
fixing these concurrently. Everything else in those files was still reviewed.
**Verification method:** read call sites + wrote throwaway pins under `tests/review/**`
(glob added to the `integration` project in `vitest.config.ts`), run against a real local
Postgres (`scripts/dev-db.sh`). Genuine confirmed bugs are pinned as `it.fails` (they fail
today, i.e. the buggy behavior reproduces; flip to `it` once fixed — that's the regression
test). `pnpm test`: 284/284 passing at the start of this review. Immediately after adding
the pins: 286 passed + 3 expected-fail (my pins) + 7 skipped, still green. **Note on later
full-suite runs:** this repo shares one Postgres instance (`scripts/dev-db.sh`,
`swenlly_test`) with the backend engineer's concurrent session; several full `pnpm test`
runs late in this review showed transient, non-reproducing failures (`beforeEach`'s
`truncateAll()` racing a concurrent test run against the same database — confirmed by
re-running the same suite moments later with all failures gone) plus one *stable* failure
in `tests/integration/display-name-sanitization.test.ts` (`falls back to a generic name
when the filename is nothing but control characters`, a Postgres UTF-8 encoding error on a
NUL byte). That file is untracked/in-progress and squarely inside the excluded scope
(appsec item 5, `display_name`/`custom_message` sanitization, owned by the concurrent
backend-engineer pass) — not evaluated or touched here. Nothing in `src/**` was touched by
this review; the 3 pins above are reproducible in isolation
(`vitest run --project integration tests/review`) independent of that contention.**

> **Fix status (fix pass 4, backend-engineer): FIXED.** The NUL-byte 500 flagged above
> (`display-name-sanitization.test.ts`'s stable failure) was `original_name`, not
> `display_name` — Postgres `text` columns cannot store a `\x00` byte at all, and
> `original_name` is an intentionally-raw audit column (unlike `display_name`, which
> already strips control characters, NUL included). `FilesService.createStaged`
> (`src/domain/files.ts`) now strips NUL bytes only from `original_name` before the
> insert, leaving it otherwise byte-for-byte raw. Covered by a new test in
> `tests/integration/display-name-sanitization.test.ts`.

---

## Must-fix (verified)

### 1. [HIGH] Deleting a file cancels nothing scheduled against it — two ways a `deleted` file resurrects with a live-looking status

Root cause, one line: `Files.deleteFile` (`src/domain/files.ts`, not edited here but read)
marks the row `status='deleted'` and best-effort-cleans external resources, but never
touches the `jobs` table. Two different already-scheduled/in-flight jobs then unconditionally
overwrite `status` later, with no re-check of "is this file still deleted?":

**1a. `file.expire`, the more likely path — no failure required.**
`files.create` schedules a `file.expire` job for `expires_at` at upload time
(`src/db/repositories/files.ts` `create` → `jobs.scheduleExpire`). Deleting the file never
cancels that job (`scheduleExpire` is only ever called from `create` and `updateSettings`,
never from `deleteFile`/`markDeleted` — verified by grep, no other call site exists). When
the file's original `expires_at` arrives, `handleFileExpire`
(`src/jobs/handlers/file-expire.ts:39`) unconditionally does
`files.setPublishStep(..., { status: 'expired' })`, flipping a sender-deleted file from
`deleted` back to `expired` — a normal, non-error timeline, not a crash/race edge case.

**1b. `file.publish`, requires a failure loop but is a straightforward consequence of the
same gap.** Deleting a file that is still `staged`/`publishing` (nothing in the HTTP route
or the view blocks this — `POST /files/:id/delete` in `src/http/routes/files.ts:212` has no
status guard, and `file-detail.eta` renders the delete button unconditionally, including
while `isPublishing`/`isFailed` is true) removes the staging blob
(`blobStaging.remove`) while the pending `file.publish` job is still queued. The job then
fails every attempt (`blobStaging.open` on the now-missing blob throws), and once it
dead-letters, `runDeadLetterHook` (`src/jobs/queue.ts:66`) unconditionally sets
`status='failed'`, again clobbering `deleted`.

Both violate `architecture.md` §3 invariant 5 ("Files are never hard-deleted... status
gates every read path") and §7 ("Delete = immediate expiry + blob removal... object
deletion") — a delete is supposed to be terminal, and here it isn't. A deleted file
reappearing as `expired` or `failed` on `/files` is confusing at best (a sender who deleted
something now sees a "retry" affordance on a resource that no longer has Drive/Zoho backing
it) and a correctness-in-the-audit-model problem at worst.

**Verified** with two throwaway pins (both `it.fails`, both fail today confirming the bug):
- `tests/review/delete-then-expire-job.test.ts` (1a — the realistic one, no error injection needed)
- `tests/review/delete-during-publish.test.ts` (1b)

**Fix:** make `deleteFile` cancel outstanding lifecycle jobs for the file — cheapest is
`jobs.scheduleExpire(pool, tenantId, fileId, null)` (already exists, already does
`DELETE FROM jobs WHERE dedupe_key = 'expire:<fileId>' AND status IN ('pending',
'processing')`) plus the equivalent for `file.publish` (`dedupe_key =
'file.publish:<fileId>'`), all inside the same transaction as `markDeleted`. Belt-and-braces:
also have `handleFileExpire` and `runDeadLetterHook`'s `file.publish` branch re-read the
file and no-op (or at least not downgrade) when `status === 'deleted'` — cheap, and closes
the window for any *other* job kind that later touches `status` the same way.

> **Fix status (fix pass 4, backend-engineer): FIXED.** `Files.deleteFile`
> (`src/domain/files.ts`) now cancels both the `expire:<fileId>` and
> `file.publish:<fileId>` jobs in the same transaction as `markDeleted`, via a new
> general-purpose `jobs.cancelByDedupeKey` repository method
> (`src/db/repositories/jobs.ts`) — `scheduleExpire`'s own cancel branch was refactored
> to call it too, instead of duplicating the SQL. Belt-and-braces guards were added
> exactly where suggested: `handleFileExpire` (`src/jobs/handlers/file-expire.ts`) and
> `Files.publishFile` (`src/domain/files.ts`, the crash-safe step machine
> `handleFilePublish` drives) both no-op on `status === 'deleted'`, and
> `runDeadLetterHook`'s `file.publish` branch (`src/jobs/queue.ts`) re-reads the file and
> skips the `status='failed'` write for the same case. `tests/review/delete-then-expire-job.test.ts`
> and `tests/review/delete-during-publish.test.ts` are flipped from `it.fails` to `it` and
> pass.

---

### 2. [HIGH] `delivery.fulfill`'s "sending" crash-recovery assumes the crash always happens *after* the physical send — it doesn't

`src/jobs/handlers/delivery-fulfill.ts`. The documented design (F-6, lines 26–44): move
`deliveries.outcome` `queued → sending` via a CAS immediately before the external send, so a
retry that finds `sending` assumes "the provider probably got it, the ack was lost" and
finalizes `sent` *without resending* — a deliberate at-most-once tradeoff to avoid a second
physical disclosure of the file (reasonable goal, and `tests/redteam/delivery-toctou.test.ts`
RT-13 correctly proves that exact scenario: send succeeds, ack is lost, retry
finalizes without resending).

The bug: `markSending` (line 130) happens, and only *after* that does the handler do local
work that can independently throw *before* `outboundMail.send` is ever called — reading the
blob (`blobStaging.open`, `streamToBuffer`), calling `SharingEngine.share` (which itself can
throw for a non-`QuotaClassError` reason, e.g. a DB error). If the handler throws in that
window, the row is left `sending` with **no send having happened**. Nothing reverts it to
`queued` on a plain-error path — only the paced-reschedule branch does that
(`deliveryFulfillment.revertSendingToQueued`, called only when `shareResult.type ===
'paced'`). The job fails and retries; the retry sees `outcome === 'sending'` and, per the
line-74 branch, **finalizes it `sent` without ever calling the outbound port.** The
requester never receives the file, but the audit log (`deliveries`, AC-A2, the thing the
architecture doc calls "visible, not invisible" by design) permanently says `sent`.

**Verified** with `tests/review/delivery-fulfill-sending-crash.test.ts` (`it.fails`): forces
`blobStaging.open` to throw once, *after* `markSending`; confirms the row is stuck
`sending` with zero mail sent after attempt 1, then confirms attempt 2 finalizes `sent`
while `outboundMail.sent` is still empty (the assertion that a real send happened is what
fails, proving the false-completion).

**Fix:** narrow what counts as "safe to finalize on retry" — either (a) revert
`sending → queued` in a `finally`/`catch` around only the local pre-send work (blob open,
buffer, and the `share()` call up to and including a caught non-`QuotaClassError`/non-paced
throw), so only a failure *after* the actual `outboundMail.send()`/`sharePermission()` call
leaves the row `sending`; or (b) record a separate marker (e.g. `sending_since` +
"outbound call attempted" boolean, or split `sending` into `sending` vs `send_attempted`)
so the retry path can tell the two cases apart instead of conflating them. (a) is the
smaller change and matches the existing `revertSendingToQueued` pattern already in
`delivery-fulfillment.ts`.

> **Fix status (fix pass 4, backend-engineer): FIXED**, via option (b) rather than (a) —
> a real two-step CAS instead of a revert-on-catch, so the states are distinguishable
> by construction rather than by an error-handling window that's easy to get subtly
> wrong. `deliveries.outcome` gained a second value, `dispatching` (migration
> `0003_delivery_dispatching_state.sql`): `queued → sending` (`markSending`, unchanged —
> before any local work) `→ dispatching` (new `deliveryFulfillment.markDispatching`, set
> immediately before the actual `outboundMail.send`/`SharingEngine.share` call) `→ sent`.
> A retry finding `sending` now redoes the whole delivery from scratch (re-running the
> F-4 gates too, since time has passed); only `dispatching` is finalized `sent` without
> resending (`reason: 'ack_lost'`), which is RT-13's exact scenario and still passes.
> One residual, documented gap: for the Drive-share path, `markDispatching` is set
> before calling `SharingEngine.share(...)` as a whole, not at the exact instant
> `sharePermission` fires inside it — `share()`'s own local, in-process reserve
> transaction runs first. Narrowing further would mean threading a callback through
> `SharingEngine`, out of scope for this pass; flagged in
> `src/jobs/handlers/delivery-fulfill.ts`'s doc comment rather than silently accepted.
> `tests/review/delivery-fulfill-sending-crash.test.ts` is flipped from `it.fails` to
> `it` and passes (its own flaky-port test double had an unrelated bug — spreading a
> class instance with `{...real}` drops prototype methods — fixed alongside). RT-13
> (`tests/redteam/delivery-toctou.test.ts`) still passes unmodified.

---

## Should-fix (verified, lower severity / defense-in-depth)

### 3. [MED] Boundary rules are enforced by convention only, despite the doc's claim

`architecture.md` §2: "Boundary rules (enforced by review + **a lint rule per direction**)."
`eslint.config.js` has no such rule — no `no-restricted-imports` (or
`eslint-plugin-boundaries`) blocking `src/domain/**` from importing `src/adapters/**`, or
`src/http/**` from importing `src/db/**` directly. I verified the boundary currently *holds*
(grepped for `from '../adapters` in `src/domain/`: none; grepped for `.query(` outside
`src/db/repositories/**`: only `health.ts`'s trivial `SELECT 1` liveness ping, which is not
business logic). So nothing is broken today — but the doc oversells the guardrail, and the
next engineer who adds a domain→adapter import (easy mistake once more adapters exist) gets
no CI signal, only a code-review catch. Cheap to close:
```js
'no-restricted-imports': ['error', { patterns: [
  { group: ['**/adapters/**'], message: 'domain/http may not import adapters directly — use a port' } ,
]}]
```
scoped via `overrides` to `src/domain/**` and `src/http/**`.

> **Fix status (fix pass 4, backend-engineer): FIXED.** `eslint.config.js` now has three
> `no-restricted-imports` blocks: `src/domain/**` may not import `**/adapters/**`,
> `**/http/**`, `**/jobs/**`, or the `pg` package; `src/http/**` may not import
> `**/db/repositories/**` or `**/adapters/**`; and everywhere else (excluding
> `src/db/repositories/**`, `src/db/pool.ts`, `src/db/migrate.ts`) may not import `pg`
> either — closing the gap this finding flagged (`container.ts` and all seven domain
> services were importing `pg` directly for the `pg.Pool`/`pg.PoolClient` types; fixed by
> re-exporting `Pool`/`PoolClient` type aliases from `src/db/pool.ts` instead of
> loosening the rule). `pnpm lint` is clean at HEAD; verified the rules actually fire (not
> just silently absent) by temporarily reintroducing one violation of each kind and
> confirming ESLint caught all four, then reverting. `architecture.md` §2's sentence now
> names the mechanism instead of just claiming it exists.
>
> This pass also closed the two *existing* violations the review's own grep missed
> (grepping only for `from '../adapters` under `src/domain/` doesn't catch `src/http/**`
> importing `src/db/repositories/**`, which three routes were doing):
> `src/http/routes/files.ts` (`files`, `tenants`, `deliveries` repositories) and
> `src/http/routes/public-share.ts` (`files.resolveBySlug`) now call new thin read
> wrappers (`FilesService.list/getById/resolveBySlug`, `AuditService.countsSentByTenant`,
> `AuthService.getTenantById`) instead. `src/http/routes/health.ts`'s two `jobs`
> repository calls now go through a new `HealthService` domain service; its bare
> `container.pool.query('SELECT 1')` liveness ping was left as-is, matching this review's
> own assessment that it isn't business logic worth routing through a repository, and
> because none of the four `no-restricted-imports` blocks above catch a raw `.query()`
> call on an already-injected pool (only import-based violations are in scope for a lint
> rule of this shape).

### 4. Minor: `handleFileExpire` re-runs external revoke calls on an already-deleted resource without guarding against it

Even setting aside finding 1, if a `file.expire` job fires after a sender already called
`deleteFile` (which the current code allows, per finding 1), it will call
`fileStore.revokeLink` on a Zoho link `deleteFile` already best-effort-deleted, and enqueue
`drive.revoke` for copies whose Drive files `deleteFile` already best-effort-deleted. Real
adapters will very likely 404/error on those (unverified — no live calls made per
`docs/verification-ledger.md`), which is at worst wasted retries into the dead-letter queue,
but is worth folding into the finding-1 fix (a `status === 'deleted'` short-circuit at the
top of `handleFileExpire` fixes both this and 1a in one place).

> **Fix status (fix pass 4, backend-engineer): FIXED**, folded into finding 1's fix as
> suggested — `handleFileExpire`'s `status === 'deleted'` guard sits before the
> `fileStore.revokeLink` call and the `drive.revoke` enqueue loop, so neither runs
> against a resource `deleteFile` already best-effort-cleaned-up.

---

## Plausible, not verified (lower confidence — flagging for the fix-pass owner, not blocking)

- **`RateLimitService`'s documented residual gap** (`src/domain/rate-limit.ts` lines 60–68):
  the file-fairness exception can itself be exploited by an attacker rotating across many
  *distinct domains* to keep exceeding a file's raw per-hour budget indefinitely. The author
  already documents and accepts this (bounded by `RATE_TENANT_PER_HOUR`/`RATE_DOMAIN_PER_HOUR`
  in the aggregate) — flagging only because it's a real, if bounded, gap a founder should
  know is accepted, not fixed.
- **`worker.ts`'s `stop()`** (`src/jobs/loop.ts`) can take up to `POLL_INTERVAL_MS` (500ms)
  per concurrent loop to actually exit, since each loop only re-checks `stopping` after its
  current `clock.sleep()` resolves. Not a bug (graceful-shutdown budgets in
  `docs/runbooks/run-and-deploy.md` almost certainly exceed 500ms), just worth confirming
  against whatever `SIGTERM` grace period the deploy target actually gives it.

---

## Things that are good — do not "fix" these

- **`SharingEngine`** (`src/domain/sharing-engine.ts`) is the strongest file in the diff:
  the two-phase reserve/external-call split, the `intent_seq` unique constraint +
  `findByIntent` recovery pairing (mutual exclusion *and* idempotency, cleanly separated),
  and the bounded reactive-retry loop with a documented, deliberate deviation from the
  architecture doc's literal wording (comment at lines 10–26) are exactly the right amount
  of paranoia for the one place the codebase accepts an external call inside a transaction.
  `tests/integration/sharing-engine.test.ts`'s 50-concurrent-callers test is a real
  concurrency proof (distinct connections, `Promise.all`), not a mocked stand-in — leave it
  alone.
- **Tenant scoping** is genuinely airtight: every repository method I checked (`deliveries`,
  `drive-copies`, `files`, `jobs`) takes `tenantId` first and filters on it in every
  statement, with exactly the two documented cross-tenant resolvers
  (`resolveByRequestToken`, `resolveBySlug`) as the only exceptions — matching
  `architecture.md` §3 invariant 1 exactly.
- **`request-pipeline.ts`'s F-2/F-7/F-9 hardening comments** are unusually good self-
  documentation of *why* a gate exists, including the specific red-team finding it closes
  and the oracle it removes (e.g. the 406-vs-200 status-code disclosure fix, F-9). This is
  the standard other domain files should be held to.
- **`jobs.ts` repository** (`claimNext`'s `FOR UPDATE SKIP LOCKED` in one round trip,
  `ensureScheduled`'s "only reactivate a `done` row, never touch `pending`/`processing`")
  is correct and matches its own doc comments precisely — no gap found between what the
  comments claim and what the SQL does.
- **`RequestPipeline`/`RateLimitService`'s "known residual gap, accepted" style** (rather
  than silently shipping a partial fix) is worth calling out as a pattern to keep — it's
  exactly what §2 of CLAUDE.md ("surfaces risk early... states what it did not verify")
  asks for.

---

## Files touched by this review

- Added (not `src/**`): `tests/review/delivery-fulfill-sending-crash.test.ts`,
  `tests/review/delete-during-publish.test.ts`, `tests/review/delete-then-expire-job.test.ts`
  — verification pins for findings 1 and 2, `it.fails` (i.e. currently red, proving the bug;
  should flip to `it` once the fix lands, at which point they become the regression tests).
- Edited: `vitest.config.ts` — added `tests/review/**/*.test.ts` to the `integration`
  project's `include` glob (harness identical to `tests/redteam`/`tests/qa`).
- Nothing under `src/**` was touched.

## Verdict

**Needs-work** on the two HIGH findings above (both are state-machine correctness bugs with
real, if narrow-to-moderate-likelihood, paths to a sender-visible or audit-log-visible wrong
status — not security-exploitable by a third party, but exactly the class of bug that erodes
trust in "the deliveries log is the source of truth"). Everything else — including all of
`sharing-engine.ts`, tenant isolation, and the inbound pipeline's gate ordering — is solid
and does not block. Fix 3 (lint rule) is cheap and should ride along; fix 4 folds into fix 1.

---

## Fix pass 4 status (backend-engineer)

All four findings above, plus the NUL-byte `original_name` 500 flagged in this review's
own intro as a stable-but-excluded failure, are **FIXED** — see the fix-status note
inline under each finding for specifics (files touched, migrations added, residual gaps
called out where one remains). All three `tests/review/**` pins are flipped from
`it.fails` to `it` and pass, alongside RT-13 (unmodified) and the full existing suite.
Two migrations were added: `0003_delivery_dispatching_state.sql` (finding 2's
`dispatching` outcome value). `pnpm typecheck && pnpm lint && pnpm exec prettier --check .
&& pnpm test && pnpm gen:ledger -- --check` is green except `prettier --check` on
`README.md`, which fails at HEAD independent of this pass (untouched by this fix pass,
owned by the concurrent technical-writer session per `CLAUDE.md`) — flagging rather than
fixing it, since it's out of this pass's scope.

---

## Polish pass review — 2026-09-10 (code-reviewer)

**Scope:** `git diff 00dfa99..HEAD` only (the two-commit "polish pass"): logger wiring
(`src/logger.ts`), quarantine suppression rows + nullable `requester_address` + `expiry_mode`/
`expiry_days` (migration `0006`), per-tenant Zoho/Drive folders, the resend route +
`AuditService.resendDelivery` + `RateLimitService.checkResend`, the e2e smoke test, and the
per-run test DB harness. **Verification method:** read every changed file plus its call
sites; wrote throwaway probes under `tests/review/*.probe.test.ts` (already covered by the
`integration` project's `tests/review/**/*.test.ts` glob); ran the full suite against real
Postgres (`scripts/dev-db.sh`). Result: 371 passed, 4 expected-fail (my `it.fails` pins,
below), 7 live-skips — no regression, nothing under `src/**` touched by this review.

### Must-fix (verified)

#### 1. [HIGH] Migration 0006 doesn't backfill `expiry_mode` — every pre-existing file with a real expiry silently loses it on the next unrelated settings save

`src/db/migrations/0006_quarantine_suppression_and_expiry_mode.sql`: `expiry_mode` is added
`NOT NULL DEFAULT 'none'` with no backfill `UPDATE`. Postgres's fast-default fills every
row that existed before this migration — including every file that already has a real
`expires_at` (the common case: `DEFAULT_EXPIRY_DAYS` gives every file an expiry unless the
sender explicitly turns it off) — with the literal default, `'none'`, regardless of
`expires_at`. `src/http/routes/files.ts`'s `expiryMode: file.expiry_mode` then pre-selects
the "no expiry" radio for a file that still very much expires, and because
`src/domain/settings.ts`'s settings form always submits `expiryMode` on every save, saving
the form for ANY OTHER reason (renaming the file, adding an allowlist entry) sets
`patch.expiresAt = null` via `resolveExpiry('none', ...)` — silently and permanently
disabling that file's expiry. Reproduced end-to-end against a scratch database seeded to
look exactly like pre-migration data (migrations 0001–0005, insert a file with
`expires_at` set, then apply 0006): `expiry_mode` comes back `'none'` next to a live,
future `expires_at`.

**Fix:** add `UPDATE files SET expiry_mode = 'custom' WHERE expires_at IS NOT NULL AND
expiry_mode = 'none';` after the `ALTER TABLE` (in a follow-up migration, since 0006 is
presumably already applied in some environments — never edit an applied migration file).
`'custom'` is the honest guess (preserves the exact stored date; there is no way to recover
whether it was originally `days`-mode).

**Pinned:** `tests/review/expiry-mode-migration-backfill.probe.test.ts` (`it.fails`).

#### 2. [MEDIUM-HIGH] Per-tenant folder `ensureFolder` (Zoho + Drive adapters) races on concurrent first uploads and has no identity across a process restart

`src/adapters/zoho/real.ts` (`ensureFolder`, ~L399) and `src/adapters/google/real.ts`
(`ensureFolder`, ~L275) both do a plain check-then-act against a **private, in-memory**
`Map<tenantName, folderId>` with no lock, no persisted folder id anywhere in the schema
(no `tenants.zoho_folder_id`/`drive_folder_id` column), and no lookup-by-name fallback
against the real API. Two concrete consequences, both reproduced:

  - Two concurrent first uploads for the same tenant both miss the empty cache and both
    issue a folder-create call — two folders for one tenant, and whichever response wins
    the cache-write is followed inconsistently by the two callers' subsequent state.
  - A fresh adapter instance (i.e. every process restart — routine in this single-process
    deployable, not just a crash) has an empty cache and, having no way to look up "does
    this tenant already have a folder," unconditionally creates ANOTHER one. Every restart
    permanently forks a tenant's storage into one more folder, forever — directly
    contradicting the fix's own doc comment ("creates (**or reuses**) one folder per
    tenant").

Neither gap is a tenant-isolation break (files still land under *some* folder belonging to
the correct tenant name), but it defeats the stated purpose of the change and will visibly
fragment tenants' storage over time in production. Compare to `SharingEngine.provision`
(architecture.md §5), which solves the identical "don't double-create under concurrency,
survive a restart" problem for Drive copies via an advisory lock + a unique DB constraint +
an `intent_key` recovery lookup — the same idiom should apply here (at minimum: persist the
resolved folder id on `tenants`, and look it up before ever creating).

**Pinned:** `tests/review/tenant-folder-race.probe.test.ts` (2× `it.fails`, one per gap).

#### 3. [MEDIUM] The resend button never appears on deliveries that arrive via live polling — only on the initial page render

`src/public/island.js`'s `prependRow` (~L333) builds exactly 4 `<td>`s (address,
mechanism, status, date) for a polled-in delivery row; `src/views/file-detail.eta`'s table
now has a 5th column (actions/resend, added in this pass). `GET /api/files/:id/deliveries`
(`src/http/routes/api-files.ts` ~L74) also never returns `canResend` or a CSRF token in its
JSON items. Net effect: a delivery that transitions to `failed`/`unconfirmed`
*after* the sender already has the page open — the normal case, since the worker sets that
outcome asynchronously, well after the page's initial SSR — never gets a resend button
until the sender manually reloads the page. This is precisely the scenario the deliveries
poller exists for (UX brief §4: "must update promptly"), so the one feature this pass
built (N-2, "no way to resend") is silently unavailable for exactly the deliveries most
likely to need it. Also a minor layout defect independent of the button: polled-in rows
have one fewer `<td>` than the header has `<th>`s.

**Fix:** have `/api/files/:id/deliveries` include `canResend` (and the file's CSRF token,
or switch the resend action to use the existing CSRF header the island already sends on
its upload XHR) in each item, and teach `prependRow` to render the 5th cell/form the same
way the server template does.

#### 4. [LOW-MEDIUM] `tests/e2e/smoke.e2e.ts`'s `bootApp()` leaks the child process on a failed readiness wait

`bootApp` (~L103–149) does `const child = spawn(...)` and then `await waitForCondition(...)`
for `/healthz` with no `try`/`finally`. If the app never becomes healthy before the 20s
timeout (a bad `DATABASE_URL`, a port collision, or a genuine boot regression — exactly the
case a smoke test exists to catch), the `await` rejects and `bootApp` never returns the
`AppHandle` that carries the only `.stop()` able to kill `child`. The caller's
`app = await bootApp(...)` in `beforeAll` then never completes, so `app` stays `undefined`
and `afterAll`'s `app?.stop()` is a no-op — the spawned process (booted with
`WORKER_ENABLED=true` against the shared/per-run test database) is leaked for the life of
the CI runner. Reproduced the identical control-flow shape (spawn, then a throwing awaited
condition, no cleanup) against a real child process and confirmed it outlives the throw.

**Fix:** wrap the readiness wait in `try { ... } catch (err) { child.kill('SIGKILL'); throw
err; }`.

**Pinned (control-flow reproduction, not the actual e2e file):**
`tests/review/e2e-bootApp-leak.probe.test.ts` (`it.fails`).

### Should-fix / suggestions (non-blocking)

- **[LOW]** The per-run test database (`tests/setup/db.ts`, `TEST_DB_PER_RUN=1`) is only
  dropped from `globalSetup`'s returned teardown, which never runs on a hard kill (OOM,
  a cancelled CI job, `SIGKILL`). `scripts/dev-db.sh` has no orphan-reaping subcommand.
  Purely an operational-hygiene gap (leaked `swenlly_test_<pid>_<random>` databases
  accumulate on the shared cluster over many cancelled runs) — worth a `dev-db.sh reap`
  step eventually, not blocking.
- **[LOW]** `REDACT_PATHS` (`src/logger.ts`) is entirely `req.*`-shaped (matches Fastify's
  HTTP request-log structure). None of this pass's new `container.logger.info({ fileId,
  tenantId, ... })`/`.error({ err }, ...)` calls log a token or address, so nothing leaks
  today — but the same logger instance is now also called directly with flat top-level
  fields from jobs/domain code, and the redaction list has no entry that would catch a
  future `logger.info({ requestToken, ... })`-shaped call. Worth a second, flat-field
  redaction path (or migrating to object-based `redact.paths` covering both shapes)
  defensively.
- **[Nice-to-have]** `RateLimitService.checkResend` deliberately reuses `RATE_FILE_PER_HOUR`
  for the resend bucket (well-documented tradeoff) — fine as shipped, but a tenant actively
  retrying failed deliveries on a busy file shares budget with inbound traffic on that same
  file with no separate `RATE_RESEND_PER_HOUR` knob if that turns out too tight in practice.

### Confirmed clean (verified, no bug found)

- `deliveries.incrementSuppressed`'s `INSERT ... ON CONFLICT ... DO UPDATE` against the
  migration 0006 partial unique index is race-safe under real concurrency: 25 concurrent
  over-cap quarantine attempts collapsed into exactly one aggregate row with the correct
  count and zero constraint-violation errors surfaced to callers.
- Resend does **not** bypass `delivery.fulfill`'s expiry/allowlist re-checks — a resent
  delivery on a file that expired *after* the original attempt correctly finalizes
  `expired`, never `sent` (`checkGatesOrTerminal` runs on every `queued` job regardless of
  how it was enqueued).
- Resend is correctly tenant- and file-scoped (`deliveries.findById(tenantId, fileId,
  deliveryId)`); a cross-tenant delivery id 404s, matching AC-A3 and every other
  tenant-scoped route in this file.
- No boundary-rule violations in this diff: the new resend HTTP route contains no SQL/
  business logic (delegates entirely to `AuditService.resendDelivery`); domain services
  only reach ports/repositories, never adapters directly; only repository modules issue SQL.
- The `expiry_mode`/`expiry_days` round-trip is correct for files created or edited
  *after* this migration — the bug is narrowly the migration's silent backfill gap
  (finding 1), not the new read/write logic itself.

### Files touched by this review

Added (not `src/**`, not committed):
`tests/review/expiry-mode-migration-backfill.probe.test.ts`,
`tests/review/tenant-folder-race.probe.test.ts`,
`tests/review/incrementSuppressed-concurrency.probe.test.ts`,
`tests/review/resend-respects-expiry-gate.probe.test.ts`,
`tests/review/e2e-bootApp-leak.probe.test.ts`.
Nothing under `src/**` was touched; nothing was committed.

### Verdict

**Needs-work.** Finding 1 (expiry-mode backfill) is a real data-integrity regression that
will silently disable expiry on existing files in any environment this migration has
already run against and must be fixed with a follow-up backfill migration before this ships
further. Finding 2 (folder-create race/no-restart-identity) undermines the per-tenant-folder
feature's own stated purpose and should be fixed before it fragments any tenant's real
storage. Findings 3–4 are real but narrower (a UX gap on the polling path; a CI-only
process leak) and can ride in the same or a fast-follow pass. Everything else in this diff
— the suppression-row aggregation, the null-requester-address plumbing, the resend feature's
tenant scoping and gate re-checks, and the logger consolidation — is solid.
