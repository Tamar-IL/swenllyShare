# Progress Log — Swenlly System 2

Three lines per chunk, newest last. Live external calls made so far: **0**.

## 2026-09-07 — Repo set up
- Team (`.claude/agents`), CLAUDE.md, PRD, research record committed.
- Discovery complete; build starts at the Design gate.

## 2026-09-08 — Design gate (PASS)
- Advisor consulted on the irreversible calls (`docs/design/advisor-consult.md`): TS/Fastify, Postgres for data+queue+locks, Mailgun Routes, Workspace SA + `drive.file`, ports & adapters with a verification ledger.
- Product-designer UX brief, visual spec, and architecture brief written (`docs/design/`); architecture-review self-gate PASS; two founder forks escalated (Google account type → AC-R4; upload ceiling 1 GB).
- `scripts/dev-db.sh` gives every engineer/CI a real local Postgres 16; SKIP LOCKED + advisory locks verified across concurrent connections.

## 2026-09-08 — Build lanes A, B-core, D (green)
- Lane A: scaffold + ten-table schema + tenant-scoped repositories + real-Postgres test harness (42 tests).
- Lane B-core: ports, semantic fakes, domain services, the 10-gate inbound pipeline, SharingEngine, worker + handlers, full route table with placeholder views, verification ledger (0 verified-live / 14 unverified-live); 114 tests green.
- Lane D: CI (real Postgres in CI via `scripts/dev-db.sh`), hadolint-clean Dockerfile, run-and-deploy runbook. Live external calls so far: **0**.

## 2026-09-08 — Lanes B2 + C, red team, security fix pass (green)
- Real Zoho/Drive/Mailgun adapters (all `@unverified-live`, offline wire tests via undici MockAgent) + `docs/runbooks/live-spikes.md`; Hebrew-first RTL UI browser-verified with Playwright.
- Red team broke the inbound pipeline (Critical: DMARC verdict read from an attacker-writable namespace; four High). All 22 pinned regressions now pass after the fix pass — auth results trusted only from a provider-stamped source (see the 2026-09-08 critic-gate entry below for the corrected, precondition-stated version of this property), RFC 5322 From parser, re-check at send time + at-most-once send, real expiry/sweep scheduling, rate-key normalization, body cap, Message-Id dedupe, kill switch `INBOUND_REQUESTS_ENABLED`.
- Sender-app QA found 8 bugs (fix pass in flight). Suite: 272 tests. Live external calls so far: **0**.

## 2026-09-08 — Gates: QA, appsec, code review; fix passes 2–4; docs (green)
- QA (8 bugs), appsec (2 must-fix incl. an unanchored `.gitignore` that had hidden the staging adapter from git), code review (2 High: delete vs scheduled jobs; sending-recovery) — all fixed, every pin flipped to a normal test; F-2 hardened to fail closed; ESLint now enforces the layer boundaries.
- README, `docs/decisions.md` (20 ADRs), build-artifacts index. Suite: 316 tests green + 7 live-gated skips.
- Critic gate: verdict FIX-FIRST (`docs/reviews/critic-report.md`) — three fatal findings, all reproduced: outbound failures could finalize `sent` without sending (F-A); the DMARC gate was forgeable in three of four realistic payload shapes despite being reported fixed (F-B); a permanently failing expiry revoke could strand a file `ready` past its own expiry, silently, forever (F-C). Two Serious findings fixed alongside (F-E derived embed token, F-G invented-code upload default); F-D (confirm-link) carried forward as an explicit founder fork, not resolved by omission.

## 2026-09-08 — Fix pass 5: critic findings F-A/B/C/E/G + doc corrections (green)
- F-A: outbound send failures now classified definite-non-send (revert + retry, eventual dead-letter) vs. ambiguous (new `unconfirmed` outcome, never `sent`); Drive-share grant and reply are independently retryable. F-C: `file.expire` dead-letters are now visible (`files.expiry_error`, `/readyz.strandedExpiries`, a file-page badge) and self-healing (`expiry.safety_sweep` reactivates them); DB/Drive-side expiry work no longer waits on the unverified Zoho revoke call.
- F-B: the DMARC gate fails closed whenever Mailgun's `message-headers` is absent (the anti-forgery guard's only source of truth), the unvalidated top-level `Authentication-Results` fallback is deleted, `MAILGUN_AUTHSERV_ID` is now required config (never `INBOUND_DOMAIN`), and `INBOUND_REQUESTS_ENABLED` now defaults `false`. F-E: a Zoho create-link response with no embed field now returns `embedToken: null`, never a value derived from the raw link; the branded page renders without an iframe in that case. F-G: `MAX_UPLOAD_BYTES` defaults to the corroborated 250 MB ceiling, and the real Zoho adapter refuses the unverified large-file path unless explicitly enabled.
- All four founder-facing "F-1 is fixed" statements corrected to state the property and its precondition, not the fix that was written (README, ADR 11, this log's B2+C entry above, red-team-report.md §6). Suite: 340 tests green + 7 live-gated skips. Live external calls so far: **0**.

## 2026-09-08 — Critic re-check → fix pass 6 (green)
- Re-check closed F-A/F-C/F-E/F-G/F-H and accepted F-D as a founder fork; F-B stayed open (authserv-id is public; source fallthrough).
- Fix pass 6 (orchestrator): one auth source, no fallback; absent/ambiguous/present classification; exact authserv-id; ambiguity or disagreement ⇒ quarantine; `/readyz.unconfirmedDeliveries`; runbook spike 3c (forged-header check) gates `authentication-results` mode.
- Suite: 348 tests green + 7 live-gated skips. Live external calls so far: **0**. Second critic re-check queued.

## 2026-09-08 — Fix pass 6b + critic third re-check: **SHIP-READY-FOR-LIVE-SPIKES**
- N-5 (RFC 8601 parsing) and N-6 (domain cross-check) closed and adversarially re-probed; N-7 docs drift closed; N-10 (one-directional cross-check) documented as residual, not tightened.
- Final suite: 356 tests green + 7 live-gated skips; zero `it.fails`; ledger 0 verified-live / 14 unverified-live. Live external calls made by anyone on this project: **0**.
- Next: the founder runs `docs/runbooks/live-spikes.md` (Zoho, Google, Mailgun 3a–3c, whitelisting) and answers the open forks in README → Open questions.
