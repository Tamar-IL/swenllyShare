# Advisor Consult — irreversible architecture calls (2026-09-08)

**Consulted before the Design gate locked the stack** (CLAUDE.md §6 "advisors before decisions").
Environment facts the advisor verified in this build container: Node 22.22 + pnpm, npm registry
reachable; PostgreSQL 16.13 server binaries installed and a cluster starts as the `postgres`
user (Docker daemon absent); `FOR UPDATE SKIP LOCKED` and `pg_advisory_xact_lock` confirmed.

## 1. Language / runtime → **TypeScript on Node 22, Fastify, single process, SSR templates**
One service serves the sender UI, the public embed page, the signed webhook, and the background
worker. Fastify's `app.inject()` gives HTTP-level tests with no port/lifecycle flake. One language
across UI/server/adapters. **Rejected:** Next.js (imports a build system + runtime split for ~6
screens and makes co-locating the webhook + durable worker awkward), Go (weak HTML iteration),
FastAPI (two languages for no gain). **Guardrail:** no SPA router / bundler; at most one
progressive-enhancement client-side island.

## 2. Datastore → **Postgres everywhere; real ephemeral Postgres in tests; queue + locks in Postgres**
Decisive reason: **AC-E2** (serialized per (tenant,file); concurrent requests create at most one
copy) can only be proven with concurrent connections. pglite is single-connection; SQLite is
single-writer without `SKIP LOCKED` — either makes the hardest correctness test a fiction.
- Jobs table + `SELECT … FOR UPDATE SKIP LOCKED` (attempts, run_after, dead-letter). ~200 lines.
- Per-key serialization: `pg_advisory_xact_lock(hashtext(tenant_id||':'||file_id))`. Locks give
  mutual exclusion, **not** idempotency → pair with a `duplication_intent` row under a unique
  constraint `(tenant_id, file_id, intent_seq)`.
- Transactional outbox: job row + audit row + state change commit in one transaction (what
  BullMQ/Redis cannot give). **Rejected:** Redis/BullMQ, pg-boss (adds schema/cron; no per-key
  mutual exclusion).
- **Risk:** the Postgres test bootstrap is fiddly (root can't run initdb) → one committed script,
  no non-Postgres path allowed.

## 3. Inbound mail → **Mailgun Routes confirmed**, behind `InboundMailPort`
- Canonical DTO: `{ providerMessageId, envelopeRecipient, fromHeaderAddress, fromHeaderDomain,
  subject, bodyText, attachments[], auth: { dmarc, spf, dkim, source }, rawPayloadHash }`.
- Adapter does exactly two things: verify the provider signature (HMAC over timestamp+token,
  replay window **and** a seen-token table — replay = re-disclosure) and map payload → DTO. No policy.
- **Fail closed:** missing/unparseable auth → `dmarc: 'unknown'`; anything ≠ `'pass'` quarantines.
  Never re-derive DMARC; never infer pass from absence.
- File identity from the **envelope recipient** (not `To:`, never body). Deliver only to
  `fromHeaderAddress`; reject multiple `From:` addresses or From-domain ≠ DMARC-evaluated domain.
- Fallback if Mailgun's auth field is absent on the live plan: Postmark — a one-file change.

## 4. Google auth → **Workspace central account + service account (domain-wide delegation) impersonating a dedicated user; files in a Shared Drive; runtime scope `drive.file`**
- Stored refresh token on a personal Gmail is a trap: "Testing" OAuth clients expire refresh
  tokens in ~7 days; tokens die on password change; and **visitor sharing (email-OTP, AC-R4) is a
  Workspace admin-controlled feature — consumer Gmail does not offer it.**
- `drive.file` suffices (upload, `files.copy`, `permissions.create` on app-created files).
  CASA exposure is zero either way for a first-party account; choose `drive.file` for blast radius.
  `supportsAllDrives=true` on all calls.
- **Founder fork (PRD §10.4):** if no Workspace, fall back to a dedicated Gmail + production-
  published OAuth client, and AC-R4 degrades to "recipient needs a Google account" — a product
  change, escalate. → The `DriveSharePort` real adapter supports both credential modes via config.

## 5. Build reality → ports & adapters with an enforced honesty boundary
- Ports: `FileStorePort` (Zoho), `DriveSharePort` (Google), `InboundMailPort`, `OutboundMailPort`,
  `Clock`, `TokenGen`. Each has a real HTTP adapter and an in-memory fake that encodes semantics
  (can emit `sharingRateLimitExceeded`, partial-upload failures, duplicate webhooks).
- One contract-test suite runs against both; the real one **reports skipped, not passed**, without creds.
- Every real adapter carries an `@unverified-live` marker; `docs/verification-ledger.md` is
  generated from the code and lists each external call as UNVERIFIED-LIVE / VERIFIED-LIVE (date).
- `ADAPTERS=fake` demo mode; the app refuses to boot with fakes when `NODE_ENV=production`.
  Every founder-facing summary states the live-call count (currently zero).
