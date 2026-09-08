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
- Red team broke the inbound pipeline (Critical: DMARC verdict read from an attacker-writable namespace; four High). All 22 pinned regressions now pass after the fix pass (auth results from `Authentication-Results` only, RFC 5322 From parser, re-check at send time + at-most-once send, real expiry/sweep scheduling, rate-key normalization, body cap, Message-Id dedupe, kill switch `INBOUND_REQUESTS_ENABLED`).
- Sender-app QA found 8 bugs (fix pass in flight). Suite: 272 tests. Live external calls so far: **0**.

## 2026-09-08 — Gates: QA, appsec, code review; fix passes 2–4; docs (green)
- QA (8 bugs), appsec (2 must-fix incl. an unanchored `.gitignore` that had hidden the staging adapter from git), code review (2 High: delete vs scheduled jobs; sending-recovery) — all fixed, every pin flipped to a normal test; F-2 hardened to fail closed; ESLint now enforces the layer boundaries.
- README, `docs/decisions.md` (20 ADRs), build-artifacts index. Suite: 316 tests green + 7 live-gated skips.
- Critic gate in flight. Live external calls so far: **0** — see `docs/verification-ledger.md` and `docs/runbooks/live-spikes.md`.
