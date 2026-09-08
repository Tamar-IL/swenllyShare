# Founder Summary — Swenlly System 2 build (2026-09-08)

**Verdict of the final gate (critic, third re-check): SHIP-READY-FOR-LIVE-SPIKES.**
Branch: `claude/swenlly-system-2-file-sharing-32nrdu` · 31 commits · 356 tests green on real
Postgres · 7 tests skip until live credentials exist · **0 live calls to Zoho, Google or Mailgun
have been made by anyone on this project** (`docs/verification-ledger.md`).

## What was built
One deployable (TypeScript, Fastify, Postgres as data + queue + locks) that gives a sender, per
upload: the raw Zoho public link (distribution link, shipping default), a `mailto:` request link
carrying an opaque 130-bit file token, and a settings panel (display name, custom message,
expiry, per-file allowlist). The inbound email-request pipeline verifies the Mailgun signature,
resolves the file by token only, reads DMARC from exactly one provider-asserted source, delivers
to the verified From address only (attachment ≤20 MB, else a Drive private share), rate-limits per
requester/domain/file/tenant, and audit-logs every outcome including "unconfirmed". The sharing
engine auto-duplicates past the Drive share cap under a per-file lock (proven with 50 concurrent
requests). The Swenlly-branded page exists behind `BRANDED_PAGE_ENABLED` (default off), streams
downloads so the Zoho URL is never visible, and renders without an iframe until Zoho returns a
real embed token. Hebrew-first RTL UI, browser-verified. CI runs the whole suite on real Postgres.

## What is proven vs. not
Proven: every PRD acceptance criterion has a test that exercises it against semantic fakes
(architecture.md §13, critic per-AC table). Not proven: every provider call. All 14 real adapter
methods are `@unverified-live`; the runbook `docs/runbooks/live-spikes.md` turns each of the
kickoff brief's four P0 spikes into a step-by-step check that flips the ledger.

## What the review loop caught (and fixed)
Red team: DMARC verdict read from an attacker-writable namespace + 10 more. AppSec: an
unanchored `.gitignore` had hidden the upload staging adapter from git; magic-link email-bombing.
QA: 8 sender-app bugs incl. duplicated audit rows. Code review: delete never cancelled scheduled
jobs; a crash-recovery path marked never-sent deliveries as sent. Critic (three rounds): transient
mail errors silently dropped files; expiry could strand forever; the authserv-id is public so the
gate needed a one-source, fail-closed design. All pinned as regression tests. Lessons: `docs/lessons.md`.

## What must be said plainly
- The inbound path ships **closed** (`INBOUND_REQUESTS_ENABLED=false`). Flip it only after spike 3
  (a–c) shows which signal Mailgun really provides and you set `INBOUND_AUTH_SOURCE` accordingly.
- Until `swenlly.com` and `workdrive.zohoexternal.com` are whitelisted, the product is the raw
  Zoho link plus the email path — valuable, unbranded.
- Upload ceiling defaults to 250 MB until spike 1 confirms Zoho's chunked upload.

## Decisions that need you (README → Open questions)
1. Google account type (Workspace + visitor sharing, or AC-R4 degrades). 2. Confirm step for
requests: none (current) or reply-to-confirm by email. 3. Zoho plan/API + embed-token reality.
4. `swenlly.com` whitelisting status. 5. Default expiry + the no-Google-account gap.
6. Own-account power tier (deferred, not built).
