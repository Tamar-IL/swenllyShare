# QA Report — Sender App, Upload, Links, Settings, Branded Page

**Owner:** qa-engineer · **Date:** 2026-09-08
**Scope:** sender app as a real user experiences it — sign-in, file list, upload, per-file
page (both artifacts, settings, audit log, delete), the branded embed page, and expiry
enforcement. PRD `docs/01-prd-file-sharing.md` §8: AC-U1..U4, AC-A2 (view), AC-A3.
**Explicitly out of scope (per assignment, not tested/edited):** the inbound-email pipeline
(`src/domain/request-pipeline.ts`, `src/adapters/mailgun/*`, `src/jobs/*`,
`src/http/routes/webhook-mailgun.ts`, `tests/redteam/**`) — a backend engineer is
concurrently editing this area; see "Test suite" below for how that showed up mid-pass.
**Method:** the real app (`ADAPTERS=fake`, real Postgres, real worker loop) driven with
Playwright/Chromium against three isolated local instances (default flag OFF; a second
with `BRANDED_PAGE_ENABLED=true`; a third with `MAX_UPLOAD_BYTES=2000`), plus direct SQL
against the dev database to seed/inspect state, plus new `app.inject()` regression tests
under `tests/qa/`.

---

## Verdict per acceptance criterion

| AC | Verdict | Notes |
|---|---|---|
| **AC-U1** (upload → 3 artifacts) | **PASS** | Distribution link, mailto with the file's own `request_token`, and the settings panel all render together the instant upload completes, zero extra clicks. |
| **AC-U2** (flag OFF → raw Zoho link) | **PASS** | Confirmed the distribution link is the raw `workdrive.zohoexternal.com` link and `/s/*` is a flat 404 regardless of slug validity. |
| **AC-U3** (flag ON → branded page) | **PASS** | `swenlly.com`-style `/s/<slug>` page, "Swenlly" wordmark, file embedded in an iframe, the raw Zoho URL never appears anywhere in the HTML, download streams through the server (200, `Content-Disposition: attachment`) rather than redirecting. |
| **AC-U4** (expiry enforced) | **PASS** on the branded-page path (expired notice replaces the embed/download; `/download` → 410); **not independently verifiable** on the flag-OFF raw-Zoho-link path from this surface, since that revocation depends on the real `FileStorePort.revokeLink` call, a fake no-op under `ADAPTERS=fake` (see Coverage gaps). Also see **Bug 4** — a *deleted* file's own page doesn't visually reflect its inactive state, which is adjacent to this AC's intent even though access is in fact revoked. |
| **AC-A2** (audit log, queryable "who received it") | **PASS with a significant caveat** — the log is real, promptly updated, and correctly shows genuinely-new deliveries via the live poll. **Bug 1 (High)** actively corrupts it over time: the same delivery re-appears as a new row on every 5-second poll tick, which breaks the "load-bearing trust mechanism" the UX brief names this table as. |
| **AC-A3** (tenant isolation) | **PASS** for every read and write path checked except one: `GET /files/:id`, the file list, and `POST /files/:id/settings` all correctly 404/omit a cross-tenant id with no distinguishing detail. **Bug 2 (Medium)**: `POST /files/:id/delete` on another tenant's file returns a false 302 "success" instead of matching that same 404 contract — the underlying data is *not* actually touched (the tenant-scoped repository query protects it), only the HTTP response is wrong. |

**Overall:** the sender-app flows are well-built — RTL, escaping, CSRF, tenant isolation on
reads, the branded page, and the upload pipeline are all solid. One **High** bug (audit-log
duplication) should block ship until fixed, since it undermines the one screen the product
is explicitly designed around. Three **Medium** and three **Low** bugs below are real but
narrower.

---

## What I verified (pass)

**Sign-in**
- Malformed email: browser-side validation blocks submit; server never sends mail for it.
- Valid email → generic "check your mail" screen, identical whether or not the address is
  registered (no enumeration).
- Resend generates a **new, distinct** magic-link token each time.
- A consumed link, reused, shows an error (not a silent second sign-in).
- An invalid/bogus token shows a friendly error page with a working "back to /signin"
  recovery link — never a 500.

**Empty state** — first-run file list matches the UX brief exactly ("עדיין לא העלית קובץ" +
a single prominent CTA).

**Upload**
- 1 KB file: uploads, publish job runs, status reaches `ready`, redirects to the per-file
  page automatically.
- `POST /api/files` with no `file` field → `400 validation_error`, not a 500.
- Oversized file (3 KB against `MAX_UPLOAD_BYTES=2000`): rejected **client-side**, before
  any network request, with a correct human-readable message ("...2KB..."); confirmed the
  **server independently** enforces the same cap (`413 too_large`) when the client check is
  bypassed via a direct `fetch`.
- Cancel mid-upload (throttled via CDP to ~150 KB/s so the window is observable): dropzone
  returns to idle, no file record is created, no navigation away from the upload screen.

**Per-file page**
- Both artifact cards (distribution + mailto) render together, always, per the brief.
- Mailto address and `href` both carry the file's exact `request_token`.
- Copy buttons: `aria-live` region announces "הועתק", `aria-label` swaps correctly, for
  both cards independently.
- Display name containing an HTML/RTL-injection payload
  (`<img src=x onerror=alert(1)>` + bidi-override characters) is escaped in the rendered
  HTML (Eta's `autoEscape: true` confirmed directly) — no raw markup reaches the DOM. It is
  stored verbatim in the DB, which is correct (escaping belongs at render time).
- Settings — expiry modes: `days` sets a correct future `expires_at`; `none` clears it;
  `custom` with a **past** date is accepted with no client/server guard (not necessarily
  wrong per spec, but worth a product decision — see Coverage gaps) and correctly flips the
  file to the "expired" display status; `custom` with an empty/invalid date shows a proper
  validation error page, never a 500 or a silent no-op.
- Allowlist: valid `user@host` and `@domain` patterns are accepted, lower-cased, and
  persisted correctly.

**Branded page (AC-U3/U4/U2)** — see verdict table above; every check passed, including
the negative check that the raw Zoho URL never appears anywhere in the branded page's HTML.

**Delete flow** — confirm dialog opens/cancels correctly (file survives cancel); confirming
delete redirects to `/files?flash=deleted` with the right banner text; the file row is
soft-deleted (`status='deleted'`), matching architecture §7.

**Audit log ("who received it")** — empty state shown correctly before any delivery; a
seeded delivery appears after reload; a **genuinely new** second delivery is correctly
picked up by the 5-second live poll with no reload. (See Bug 1 for the real defect in this
same mechanism.)

**Tenant isolation** — two browser contexts, two tenants: `GET /files/:id`,
`POST /files/:id/settings`, and the file list all correctly 404/omit tenant X's data when
tenant Y tries to reach it via crafted URLs/POSTs, with no distinguishing detail leaked.

**Console / server errors** — no unexpected client console errors and no unexpected 5xx
from the app across the whole pass (the only noise was `net::ERR_FAILED`/`ERR_CONNECTION_RESET`
from Google Fonts, which this sandbox has no route to — expected, not an app bug; blocked
for cleanliness in later scripts). One real log-quality finding: see Bug 8.

---

## Bugs found

### Bug 1 — HIGH — Deliveries live-poll duplicates the latest row on every poll tick
**Files:** `src/db/repositories/deliveries.ts` (`listForFile`, the `created_at > $3`
comparison) · `src/http/routes/files.ts:149` (`deliverySinceIso`) ·
`src/public/island.js:303,355,368` (the `since` cursor)

**Root cause:** the poll's `since` cursor is serialized with `Date#toISOString()`
(**millisecond** precision), but `deliveries.created_at` is Postgres `timestamptz`
(**microsecond** precision). `created_at > since` in SQL therefore stays **true for the
very row `since` was derived from**, because that row's real value almost always has a
non-zero sub-millisecond remainder (e.g. cursor `...:15.936Z` vs. the DB's real
`...:15.936892+00` — `.936892 > .936000`). The client then sets its own `since` to that
same (still-truncated) value, so the next poll matches the same row again — indefinitely.

**Repro (HTTP, deterministic — pinned in `tests/qa/qa-sender-app-regressions.test.ts`):**
insert one delivery row, take its own `created_at.toISOString()` as `since`, call
`GET /api/files/:id/deliveries?since=<that value>` → returns that same row (expected: 0
items).

**Repro (browser, end-to-end):** seed exactly one delivery via SQL, load the per-file page,
wait 16s (three 5-second poll cycles), screenshot at
`/tmp/claude-0/qa-out/05-duplicate-poll-bug.png`. DB has exactly 1 real row throughout;
the DOM ends with **4 rows**, all the same delivery — one new duplicate appears per poll
tick, growing without bound for as long as the page stays open and no newer delivery
arrives.

**Impact:** this is the exact mechanism the UX brief (§4) names as *"the load-bearing trust
mechanism"* for the whole product — a sender who leaves the file-detail page open sees the
delivery count silently multiply, which reads as either a bug or (worse) as the file being
requested far more than it actually was.

**Fix direction (not applied):** replace the bare timestamp cursor with a keyset cursor
that excludes the boundary row itself (`created_at > since OR (created_at = since AND id >
last_id)` with full-precision comparison, or simplest: `created_at >= since AND id !=
$last_seen_id`), or preserve full microsecond precision end-to-end instead of round-tripping
through `toISOString()`.

---

### Bug 2 — MEDIUM — Cross-tenant `POST /files/:id/delete` returns a false 302 "success"
**File:** `src/http/routes/files.ts` ~L206-214

```js
app.post<{ Params: { id: string } }>(
  '/files/:id/delete',
  { preValidation: app.csrfProtection, preHandler: requireSessionHtml },
  async (request, reply) => {
    if (!request.tenantId) return;
    await container.services.files.deleteFile(request.tenantId, request.params.id);
    return reply.redirect('/files?flash=deleted');   // <- always, regardless of outcome
  },
);
```

`FilesService.deleteFile()` (`src/domain/files.ts:213`) correctly does a tenant-scoped
`findById` first and returns `undefined` — a true no-op — when the id belongs to another
tenant or doesn't exist. **The route never checks that return value.** It always redirects
with `flash=deleted`, identical to a real successful delete.

**Repro:** sign in as tenant Y, `POST /files/<tenant X's file id>/delete` with tenant Y's
own valid CSRF token → **HTTP 302** to `/files?flash=deleted`. Confirmed via direct DB
query that the file is untouched (`status` unchanged) — **no actual data loss** — but the
HTTP contract is wrong, and inconsistent with the *same file's* `GET /files/:id` and
`POST /files/:id/settings` handlers, both of which correctly 404 in the identical scenario
(this file's own doc comment at the top even promises "a wrong tenant gets a plain 404 ...
never a 403 with any distinguishing detail" — the delete route breaks that promise).

**Pinned:** `tests/qa/qa-sender-app-regressions.test.ts` (`it.fails`).

---

### Bug 3 — MEDIUM — Settings save is not atomic: one bad allowlist line lets other fields commit silently
**File:** `src/domain/settings.ts`, `SettingsService.updateSettings()`

`files.updateSettings()` (persists `displayName`/`customMessage`/`expiresAt`/
`allowlistMode`) is awaited and **committed** before the allowlist pattern strings are
validated. `validatePattern()` then throws on a bad line, and the route renders a 200
error page — which reads to the sender as "nothing was saved" — but the earlier writes in
the *same submission* already landed.

**Repro:** on an existing file, submit a settings form with a new `displayName`,
`allowlistMode=allowlist`, and one bad allowlist line
(`good@example.com` + `NOT-A-VALID-PATTERN`) in one POST. Server responds with an error
page ("invalid allowlist pattern..."). DB check: `displayName` **did** change and
`allowlistMode` **did** flip to `'allowlist'` — only the allowlist pattern list itself was
left unwritten (at its old value).

**Impact:** a sender who mistypes one allowlist address believes the whole edit failed, but
the file's access mode may have silently narrowed from "open" to "allowlist-restricted"
using a stale address list — a realistic support-ticket generator ("my recipients can't get
the file anymore") for exactly the kind of access-control setting this product needs to be
predictable about.

**Pinned:** `tests/qa/qa-sender-app-regressions.test.ts` (`it.fails`).

---

### Bug 4 — MEDIUM/LOW — A deleted file's own page still shows its links as fully live
**File:** `src/http/routes/files.ts:123` — `isExpired: displayStatus === 'expired'`

`computeDisplayStatus()` (`src/lib/presentation.ts:27`) correctly returns a distinct
`'deleted'` status (pill shows "נמחק" correctly), but `file-detail.eta`'s artifact cards
only branch their disabled/warning state on `it.file.isExpired`, which is **never true**
for a deleted file.

**Repro:** delete a file, revisit its own `/files/:id` page (still reachable by the owning
tenant — expected) → status pill correctly reads "נמחק", but **both artifact cards render
as fully active**: copy buttons enabled, no "no longer active" explainer — contradicting
the UX brief's stated behavior for exactly this state ("deleting removes access immediately
... equivalent to instant expiry").

**Fix direction:** the `isExpired` field (or the eta template's condition) needs to also
cover `displayStatus === 'deleted'`.

---

### Bug 5 — LOW — `formatByteCeiling()` renders "0MB" for any cap under 1MB
**File:** `src/lib/presentation.ts:129-137`

No KB tier; `Math.round(mb)` rounds any sub-1MB value to 0.

**Repro:** with `MAX_UPLOAD_BYTES=2000` (used to exercise the oversize path), `GET
/files/new` renders "קבצים גדולים עד **0MB** נתמכים". By contrast the **client-side**
`humanSize()` in `src/public/island.js` (used for the inline rejection message) correctly
formats the identical value as "2KB" — two independent byte-formatters in the codebase
disagree. Low severity because the production default (1 GB) never reaches this path, but
it's a real, demonstrable bug that will surface the moment any low-cap config is used.

**Pinned:** `tests/qa/qa-sender-app-regressions.test.ts` (`it.fails`).

---

### Bug 6 — LOW/MEDIUM — Sign-in rate limit is keyed by IP only, not "per IP and per email" as documented
**File:** `src/app.ts` — `@fastify/rate-limit` registered with no `keyGenerator` on the
`/signin` route.

`docs/design/architecture.md` §8 states `RATE_MAGICLINK_PER_HOUR` "caps sign-in requests
**per IP and per email**." The actual registration has no custom key, so Fastify's default
(IP-only) applies: requests for **different** email addresses from the same IP share one
bucket.

**Impact:** a burst of ≥5 sign-in attempts for one address from a shared IP/NAT/VPN egress
silently blocks sign-in for **every other sender's email** behind that same IP for up to an
hour — with no distinguishing error shown (the same generic "check your mail" screen
renders regardless, so nothing even signals the block). I hit this myself mid-pass running
routine QA from one machine. This is a real production risk for any shared-egress
environment, not just a test-harness inconvenience.

**Pinned:** `tests/qa/qa-sender-app-regressions.test.ts` (`it.fails`).

---

### Bug 7 — MEDIUM (visual, every page) — ~150px blank band above the header
**Root cause confirmed:** `src/views/layout.eta:47`'s inline icon sprite —
`<svg hidden aria-hidden="true" focusable="false">` — relies solely on the HTML `hidden`
boolean attribute to stay invisible. Verified via an isolated minimal reproduction (a bare
`<svg hidden>` in an otherwise-empty HTML document, zero app CSS, in the project's target
Chromium build): **Chromium does not apply `display:none` to a root `<svg>` element via the
`[hidden]` attribute selector** the way it does for ordinary HTML elements. The element
renders at the browser's default replaced-element size (**300×150 CSS px**), and since it's
the first element in `<body>` after the skip-link, that phantom ~150px box pushes the
header — and everything after it — down on **every** page. `src/public/app.css` has no
`[hidden]` or `svg[hidden]` rule anywhere to compensate.

This is the cause of the blank band flagged in
`docs/design/screenshots/02-file-detail-desktop.png`; I reproduced it live and consistently
across the empty file list, the file-detail page, and the branded-expired page (see
`/tmp/claude-0/qa-out/01-empty-state.png` and `/tmp/claude-0/qa-out/03-deliveries-live.png`).

**Fix direction (not applied — out of my remit):** add explicit CSS, e.g.
`svg[hidden]{display:none}`, or set the sprite `<svg>`'s size/positioning explicitly
instead of relying on the bare `hidden` attribute for a root SVG element.

---

### Bug 8 — LOW (operational) — Cancelling an upload logs a level-50 "unhandled error"
Observed directly in the dev server log during the cancel-mid-upload test: a normal,
expected user action (clicking "בטל") produces a Fastify **error-level** log line:
```
{"level":50,...,"err":{"type":"Error","message":"aborted",...,"code":"ECONNRESET"},"msg":"unhandled error"}
```
In production this will fire on every legitimate cancel click, polluting error-rate
dashboards/alerts with false positives indistinguishable from a real server fault. Not
pinned as a regression test (this is log-level tuning around Fastify's abort handling, not
a functional HTTP contract) — flagging for backend/platform engineer.

---

## Coverage gaps (not run, and why)

- **True magic-link TTL expiry** (15 min) was not waited out live — verified by code
  reading only. The "invalid/never-issued token" path was exercised instead and behaves
  correctly, but the exact "issued, then genuinely expired" path is unverified live.
- **"Expiring soon" (amber, ≤3-day window) status chip** — verified by code review only
  (`computeDisplayStatus`/`STATUS_META` in `src/lib/presentation.ts`), not exercised live in
  the browser (traded off against the sign-in rate limit, Bug 6, once its cost became
  clear mid-pass).
- **AC-U4 on the flag-OFF (raw Zoho link) path** depends on the real
  `FileStorePort.revokeLink` call inside the `file.expire` job actually revoking the
  external link; under `ADAPTERS=fake` that's a no-op by design, so it's unverifiable from
  the sender-app surface this pass owns (contract tests exist under
  `tests/contract/file-store.test.ts`, outside this pass's remit).
- **Drag-and-drop file selection** was not exercised (unreliable to simulate faithfully via
  Playwright against a native OS file drag); the file-picker path was tested instead, which
  carries the actual functional risk (drag-over is pure CSS state per `island.js`).
- **Mobile/narrow-viewport layout** (visual-spec's `--bp-sm`/`--bp-md` breakpoints, RTL
  mirroring on small screens) was not visually verified — all screenshots were captured at
  a desktop viewport.
- **Two tabs of the same tenant open on the same file simultaneously**, one deleting while
  the other is live, was not tested (distinct from the "revisit a stale link later" case I
  did test — Bug 4).
- **Real (non-fake) Zoho/Drive/Mailgun adapters** were not exercised — explicitly
  `@unverified-live` per architecture.md and outside this pass's remit regardless.
- **Assistive technology**: `aria-live` announcements were verified structurally (DOM
  content after actions), not with an actual screen reader.

---

## Test suite (`pnpm test`)

The working tree had a backend engineer's **concurrent, uncommitted** changes throughout
this pass (`src/domain/request-pipeline.ts`, `src/adapters/mailgun/*`,
`src/domain/rate-limit.ts`, and — appearing mid-session — a new migration
`src/db/migrations/0002_delivery_sending_state.sql`), exactly the area I was told not to
test or edit. The full suite was consequently a moving target:

- **Cleanest snapshot captured this pass** (before that work progressed far enough to
  destabilize its own tests): **44 test files, 216 passed, 26 expected-fail (22
  pre-existing + this pass's regression tests once added), 7 skipped — 0 unexpected
  failures.**
- **Final snapshot** (`/tmp/claude-0/qa-out/full-test-run-latest.log`): 8 files / 24 tests
  failing, **every one of them** inside `tests/redteam/**` plus
  `tests/integration/{inbound-injection,inbound-messages-replay,migrate}.test.ts` — all
  exercising `request-pipeline.ts`/the Mailgun adapters/the new migration, i.e. entirely
  the concurrent, out-of-scope work. **Zero failures** in any file this pass actually
  covers: `upload-flow`, `tenant-isolation*`, `isolation`, `links`, `expiry`, `allowlist`,
  `audit` (the delivery-count parts, not the pipeline-outcome parts), `security-headers`,
  `sharing-engine`, `drive-copies-concurrency`, `jobs`, `production-refuses-fakes`,
  `webhook-signature`, every `tests/unit/*`, every `tests/contract/*`, and this pass's own
  `tests/qa/*`.
- `pnpm test` was **not** run again after this to "wait for a clean number," since the
  instability is squarely the other lane's in-flight work, not this pass's responsibility
  to chase.

New regression tests added (`tests/qa/qa-sender-app-regressions.test.ts`, 5 cases, all
`it.fails` — each reproduces a real bug above and will flip to a normal passing test the
moment its bug is fixed):
1. Bug 2 — cross-tenant delete false-success.
2. Bug 3 — settings partial-write on allowlist validation failure.
3. Bug 5 — `formatByteCeiling()` "0MB".
4. Bug 6 — sign-in rate limit keyed by IP only.
5. Bug 1 — deliveries `since` cursor re-matches its own source row.

`vitest.config.ts` was given a minimal one-line addition (the `tests/qa/**/*.test.ts` glob
in the `integration` project's `include` list) so this file runs under `pnpm test` /
`pnpm test:integration` going forward.

---

## Fix status (backend-engineer pass, 2026-09-08)

All 8 bugs below are fixed. `tests/qa/qa-sender-app-regressions.test.ts`'s 5 originally-pinned
`it.fails` cases are flipped to `it` and pass; 1 new case was added for Bug 4 (feasible at HTTP
level) and 2 new cases were added elsewhere for Bug 8 (`tests/unit/error-handler.test.ts`, pure
function + a real Fastify instance asserting the actual log level). Bug 7 (CSS-only, no
functional/HTTP surface) has no automated regression test — see its entry below. Full suite:
`pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm gen:ledger --
--check` all green, 284 passed / 7 skipped, **zero `it.fails` anywhere in `tests/`**.

- **Bug 1 (High, deliveries cursor duplication) — fixed.** Redesigned as a `(created_at, id)`
  keyset cursor: `deliveries.listForFile()` now takes an optional `sinceId` and excludes the
  anchor row by id (`created_at >= since AND id <> sinceId`) instead of relying on a
  millisecond-precision `created_at > since` alone; falls back to the original strict `>` when
  no `sinceId` is given (no worse than before for a caller that doesn't have one). `GET
  /api/files/:id/deliveries` now accepts `sinceId` and returns each item's `id`; the file-detail
  page emits a paired `data-since`/`data-since-id`; `island.js`'s poll keeps both in sync. Test:
  `tests/qa/qa-sender-app-regressions.test.ts` (flipped, plus a same-cursor-returns-nothing AND a
  genuinely-new-row-still-comes-through assertion).
- **Bug 2 (Medium, cross-tenant delete false-success) — fixed.** `POST /files/:id/delete` now
  checks `FilesService.deleteFile()`'s return value and 404s when it's `undefined` (cross-tenant
  or unknown id), matching every sibling tenant-scoped route in the file. Test: flipped pin.
- **Bug 3 (Medium, settings save not atomic) — fixed.** `SettingsService.updateSettings()` now
  validates every allowlist pattern BEFORE issuing any write, then commits `files.updateSettings`
  and `fileAllowlist.replaceAll` together inside one `withTransaction` — a bad pattern can no
  longer leave `displayName`/`expiry`/`allowlistMode` partially committed. Test: flipped pin.
- **Bug 4 (Medium/Low, deleted file shows live artifacts) — fixed.** `GET /files/:id` now treats
  `displayStatus === 'deleted'` like `'expired'` for the `isExpired` read-model field, so both
  artifact cards disable/warn exactly like an expired file. Test: new case added to
  `tests/qa/qa-sender-app-regressions.test.ts` (HTTP-level — asserts the rendered `is-disabled`
  class on both cards after a real delete).
- **Bug 5 (Low, `formatByteCeiling` "0MB") — fixed.** Added a KB tier (mirrors `island.js`'s
  client-side `humanSize()`), so any cap under 1MB now renders correctly (e.g. "2KB" for 2000
  bytes) instead of rounding to "0MB". Test: flipped pin.
- **Bug 6 (Low/Medium, sign-in rate limit IP-only) — fixed.** Now genuinely per IP AND per email,
  matching architecture.md §8: the `@fastify/rate-limit` route registration is keyed by the
  `(ip, email)` pair (was IP alone) so a burst for one address no longer exhausts the budget for
  every other address behind a shared IP/NAT; `AuthService.requestMagicLink` additionally enforces
  a genuinely IP-independent per-email cap on the same Postgres sliding window every other rate
  gate uses (`rate_limit_counters` / `RateLimitService`'s mechanism), keyed purely by email.
  Test: flipped pin, rewritten to actually exercise CSRF + the rate limiter (the original pin
  posted with no CSRF token/cookie at all and was passing only because that 403'd before ever
  reaching the code under test — corrected in the same pass since it was being rewritten anyway).
  Covers: 3 different addresses from one IP (none blocked), the same address repeated past the
  cap from one IP (still blocked, unchanged), and the same address from 3 different IPs (the
  domain-level per-email cap still applies — verified via suppressed outbound mail, not HTTP
  status, since the response is always 200 by the no-enumeration design either way).
- **Bug 7 (Medium, visual, `<svg hidden>` blank band) — fixed.** Added `svg[hidden]{display:
  none}` to `app.css`'s reset section — Chromium doesn't apply the `[hidden]` UA rule to a root
  `<svg>` the way it does for ordinary elements. No automated test: this is a pure rendering bug
  with no HTTP/DOM-structure signature to assert on at the `app.inject()`/unit level available in
  this codebase (no Playwright/browser harness in `tests/`); flagged as a gap, consistent with
  this pass's remit (unit/integration tests only).
- **Bug 8 (Low, operational, ECONNRESET logged as error) — fixed.** `error-handler.ts` now
  classifies `ECONNRESET`/`ECONNABORTED`/`EPIPE` (`isClientAbortError`, newly exported) and logs
  those at `info`, not `error` — a legitimate upload-cancel click no longer produces an
  error-rate-dashboard-polluting "unhandled error" log line. HTTP response/status is unchanged.
  Test: new `tests/unit/error-handler.test.ts` — a pure-function check for the classifier, plus a
  real Fastify instance + custom log stream asserting the actual emitted log level (never 50) for
  a classified error, and unchanged (`50`) for a genuine unexpected error.

---

## Files referenced in this report

- `src/http/routes/files.ts` (lines 123, ~206-214)
- `src/domain/settings.ts` (`updateSettings`)
- `src/domain/files.ts` (`deleteFile`, line 213)
- `src/lib/presentation.ts` (lines 27, 129-137)
- `src/db/repositories/deliveries.ts` (`listForFile`)
- `src/public/island.js` (lines 303, 355, 368)
- `src/views/layout.eta` (line 47), `src/views/file-detail.eta`, `src/public/app.css`
- `src/app.ts` (`@fastify/rate-limit` registration)
- `tests/qa/qa-sender-app-regressions.test.ts` (new)
- `vitest.config.ts` (one-line diff: added `tests/qa/**/*.test.ts` to the integration
  project's `include`)

Screenshots and raw run logs: `/tmp/claude-0/qa-out/` (not committed — local evidence only).

### Additionally touched by the fix pass (2026-09-08)

- `src/http/routes/api-files.ts` (`GET /api/files/:id/deliveries` — `sinceId`, `id` in response)
- `src/domain/audit.ts` (`listForFile` opts passthrough)
- `src/domain/auth.ts` (`AuthServiceConfig`, per-email rate cap in `requestMagicLink`)
- `src/http/routes/signin.ts` (rate-limit `keyGenerator`/`hook`)
- `src/http/plugins/error-handler.ts` (`isClientAbortError`, new export)
- `src/container.ts` (`AuthService` construction — `RATE_MAGICLINK_PER_HOUR`)
- `tests/setup/http.ts` (`getCsrfToken` — optional `remoteAddress`)

---

## Browser harness (QA fix pass 7, 2026-09-10)

Bug 7's "no automated test" gap above is closed: `tests/e2e/smoke.e2e.ts` (vitest project
`e2e`, gated on `E2E=1` — see `vitest.config.ts` and `pnpm test:e2e`) is a real-Chromium
(`playwright-core`, driven against `/opt/pw-browsers/chromium`), real-server (`tsx
src/server.ts` as a child process, `ADAPTERS=fake`, `WORKER_ENABLED=true`,
`BRANDED_PAGE_ENABLED=true`), real-Postgres smoke test that drives one full sender-app
session end to end: sign-in via the fake magic link, the empty state, uploading a 1KB file,
the status poll to ready, both artifact cards (mailto address carries the request token),
the copy button's "הועתק" swap, a settings-save round trip, the deliveries table polling
without duplicating a SQL-seeded row (the exact shape of Bug 1, now also covered from the
browser side), and the branded page (`Swenlly` wordmark present, the raw Zoho public link
never in the HTML). It specifically re-verifies Bug 7 itself: it reads
`header.getBoundingClientRect().top` in-page and asserts it is exactly `0` — a regression to
the pre-fix ~150px blank band would fail this test, not just look wrong in a screenshot.
This does not replace visual review (no screenshots are taken or compared, so a paint-order/
color regression that doesn't move layout would still slip through) but it does mean "is
there a browser-shaped blank band above the header" is now a CI fact, not a claim.
- `tests/unit/error-handler.test.ts` (new)
