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

### 4. Minor: `handleFileExpire` re-runs external revoke calls on an already-deleted resource without guarding against it

Even setting aside finding 1, if a `file.expire` job fires after a sender already called
`deleteFile` (which the current code allows, per finding 1), it will call
`fileStore.revokeLink` on a Zoho link `deleteFile` already best-effort-deleted, and enqueue
`drive.revoke` for copies whose Drive files `deleteFile` already best-effort-deleted. Real
adapters will very likely 404/error on those (unverified — no live calls made per
`docs/verification-ledger.md`), which is at worst wasted retries into the dead-letter queue,
but is worth folding into the finding-1 fix (a `status === 'deleted'` short-circuit at the
top of `handleFileExpire` fixes both this and 1a in one place).

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
