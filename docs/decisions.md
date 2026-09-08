# Decisions Log — Swenlly System 2

ADR-style record of the non-obvious calls made during this build. Each entry: **Context** (the
fork) → **Decision** (what we chose) → **Consequence** (what that costs or unlocks). Sourced from
`docs/design/advisor-consult.md`, `docs/design/architecture.md` §0/§12, and the fix passes in
`docs/security/red-team-report.md` and `docs/qa/qa-report-sender-app.md`. Superseding a decision
here means adding a new entry, not editing the old one.

---

### 1. Single TS/Node process, Fastify, SSR — not Next.js, not a split UI/API
**Context:** ~9 screens, one webhook, one background worker; pick a framework once.
**Decision:** TypeScript on Node 22 + Fastify + Eta SSR, one process, one language. Rejected
Next.js (build-system split, awkward co-location of the durable worker), Go (weak HTML
templating), FastAPI (two languages for no gain).
**Consequence:** `app.inject()` gives HTTP-level tests with no port flake; at most one
progressive-enhancement JS island, no bundler, no SPA router.

### 2. Postgres for data, job queue, and locks — no Redis/BullMQ
**Context:** AC-E2 (auto-duplication serialized per tenant/file, no overshoot) is only provable
with real concurrent connections; pglite is single-connection, SQLite has no `SKIP LOCKED`.
**Decision:** One Postgres instance backs the schema, a `jobs` table (`FOR UPDATE SKIP LOCKED`,
backoff, dead-letter), and `pg_advisory_xact_lock` for per-key mutual exclusion.
**Consequence:** No queue service to run or pay for; the hardest correctness test
(`tests/integration/sharing-engine.test.ts`) runs against a real database, not a fake.

### 3. Mailgun Routes behind `InboundMailPort`, DMARC fails closed
**Context:** inbound file-requests need signature verification and a provider-asserted auth
verdict, with a documented Postmark fallback if Mailgun's auth field turns out absent.
**Decision:** One port, one real adapter; missing/unparseable auth → `dmarc: 'unknown'`, never
inferred as `pass`.
**Consequence:** Swapping providers is a one-file change; the fail-closed default meant the F-1
red-team break (below) was a mapping bug, not a design gap.

### 4. Google Workspace service account (domain-wide delegation) over per-sender OAuth
**Context:** AC-R4 needs email-OTP visitor sharing, which is a Workspace admin feature a
consumer Gmail refresh token does not offer; stored personal-Gmail tokens also expire in ~7 days
in "Testing" OAuth clients.
**Decision:** Central Workspace account, SA + domain-wide delegation impersonating a dedicated
user, files in a Shared Drive, runtime scope `drive.file` (not full Drive — zero CASA exposure,
smallest blast radius). `DriveSharePort` also supports `oauth_refresh` mode behind config.
**Consequence:** If the founder has no Workspace, AC-R4 degrades to "recipient needs a Google
account" — a product change, escalated as a founder fork (PRD §10.4), not silently built around.

### 5. Ports & adapters with an enforced honesty boundary
**Context:** nothing in this build has called a real provider API yet; false confidence in an
unverified integration is worse than an honest gap.
**Decision:** Every external call sits behind a port with a real adapter and a semantic fake;
every real method carries `@unverified-live` / `@verified-live(date)`; `docs/verification-ledger.md`
is generated from those markers and CI fails if it drifts from the code.
**Consequence:** `ADAPTERS=fake` gives a full demo with zero credentials; the app refuses to boot
with fakes in production; every status report can state the live-call count honestly (currently 0).

### 6. No confirm-link step; per-file allowlist instead (deliberate PRD override)
**Context:** `research/03 §2` mandates both an owner allowlist and a confirm-link before any
auto-share. The PRD's AC-R3 model is "deliver to the DMARC-verified From address only."
**Decision:** The PRD wins on precedence and on the merits — with DMARC-pass required and
delivery hard-bound to the From address, a confirm-link defends exactly the case DMARC already
blocks (a forged From can't be clicked by the attacker). Not built. The allowlist ships as a
per-file opt-in (`allowlist_mode`, default `open`) since it is *not* redundant — it's the only
control against "anyone holding the mailto link may fetch the file."
**Consequence:** Stricter than the PRD requires, satisfies `research/03`'s intent without the
UX cost of a confirm round-trip on every request.
**Amendment (critic F-D, orchestrator, 2026-09-08):** this was a product call taken by the
architect, and after the F-B findings it is no longer "redundant by construction" — it is a
defense-in-depth layer the founder should decide on. It stays **not built** for a product reason
found during review: a click-to-confirm link is unopenable by this product's own audiences
(email-only users cannot open external links; filtered users cannot open `swenlly.com` until it
is whitelisted). The buildable variant is **reply-to-confirm by email** (`cust-<slug>+confirm-
<token>@`, DMARC-gated like every inbound message), which adds one email round-trip per request.
Carried as a founder fork in README → Open questions; the per-file allowlist and the
`INBOUND_REQUESTS_ENABLED` kill switch are the shipped controls meanwhile.

### 7. Central accounts by default; sender's-own-account is a deferred power tier
**Context:** per-sender OAuth re-introduces the CASA question at scale and a whole-inbox blast
radius; the founder wants a "their brand" option eventually.
**Decision:** MVP ships central Google Drive + Zoho WorkDrive accounts only, per-sender folders,
`drive.file` scope. The own-account tier is listed as an open question (PRD §10.1), not built.
**Consequence:** No OAuth consent screens or CASA review needed to ship; revisiting this later is
additive (a new credential mode), not a rewrite — `DriveSharePort` already supports two modes.

### 8. Local-disk staging; single stateful node
**Context:** uploads must land somewhere before the async publish job pushes them to Zoho/Drive.
**Decision:** Stream uploads to local disk (`BlobStagingPort`, `STAGING_DIR`) rather than standing
up an object store for MVP.
**Consequence:** Exactly one node may run against a given `STAGING_DIR` — no horizontal scaling
until an S3/R2 adapter replaces it (one-adapter change, not a redesign, per architecture.md §6).

### 9. Branded page streams the download; never redirects to Zoho
**Context:** AC-U3 requires the raw Zoho URL to never appear as the visible destination.
**Decision:** `GET /s/:slug/download` proxies bytes through the server
(`FileStorePort.openDownload`) with `Content-Disposition: attachment`, instead of a 302 to the
Zoho link.
**Consequence:** Bandwidth cost is paid by the server while the flag is on; accepted for MVP since
the flag defaults off, with a CDN as the scale answer once branding ships live.

### 10. `request_token` and `public_slug` are different tokens, never one
**Context:** one token drives the inbound mailto address; a different one (when the flag is on)
drives the public branded-page URL.
**Decision:** Two distinct 130-bit tokens per file, each single-purpose.
**Consequence:** Holding the web link never lets you derive the inbound address (or vice versa) —
each capability has its own audience, closing a cheap correlation attack for free.

### 11. F-1 (critical) — DMARC verdict read only from an allowlisted field set
**Context:** the red team showed `mapping.ts` probed guessed key names (`dmarc`,
`X-Mailgun-Dmarc-Result`, …) in the same flat payload namespace Mailgun uses for the message's own
MIME headers — an attacker could type `X-Mailgun-Dmarc-Result: pass` into their own email.
**Decision:** Read auth results only from Mailgun's `message-headers` `Authentication-Results`
entry (matched by `MAILGUN_AUTHSERV_ID`) or a small allowlisted set of lowercase synthetic field
names; discard everything else before mapping.
**Consequence:** Closes the full auth bypass (RT-01/RT-05); the field-name guess itself remains
`@unverified-live` until a live payload is captured (live-spikes runbook, spike 3).

**Fix pass 5 correction (F-B, `docs/reviews/critic-report.md`):** the critic's re-check found
this closed one payload shape out of four — the top-level "degraded fallback" performed no
authserv-id check at all, and the anti-forgery guard (`knownHeaderNames`, derived entirely from
`message-headers`) was inoperative whenever `message-headers` was simply absent, which is a
documented, contemplated condition, not exotic. The property that now holds, stated with its
precondition: **DMARC is read only from a provider-stamped source — Mailgun's own synthetic
fields, or a `message-headers` `Authentication-Results` entry whose authserv-id exactly matches
`MAILGUN_AUTHSERV_ID` — and ONLY when `message-headers` is present; when it is absent, every
auth field reads `unknown` and the request is quarantined, never treated as a pass.** The
top-level "degraded fallback" was deleted, not hardened — it was never reachable safely.
`MAILGUN_AUTHSERV_ID` is now required configuration wherever it matters (real adapters, or the
inbound path on in production) and NEVER defaults to `INBOUND_DOMAIN` (public, guessable — the
exact value the critic's forged payloads exploited). `INBOUND_REQUESTS_ENABLED` now defaults
`false` (was `true`) — a kill switch built for an unverified assumption must default to the safe
position.

### 12. F-2 — DMARC alignment fails closed on a domain-less `pass` (orchestrator decision)
**Context:** gate 6's alignment check silently no-ops when the evaluated domain can't be read,
even though `dmarc` itself fails closed on the identical uncertainty — and two existing test pins
(`SANITY`/`DOCUMENTED`) asserted the looser behavior.
**Decision:** Per PRD precedence rule 4 (safety invariants may only get stricter), a `pass` with no
readable evaluated domain now quarantines (`dmarc_alignment_unknown`) rather than passing. The two
pinned tests were corrected to send a realistic payload (a real `pass` always carries the domain
it evaluated), not weakened.
**Consequence:** No `pass` verdict is ever accepted without a domain to align against.

### 13. F-9 — unknown request token returns 200, not 406
**Context:** architecture.md promised "no disclosure of whether a token ever existed," but a
known-but-failing token returned 200 while an unknown one returned 406 — an external oracle.
**Decision:** Unknown token → 200 (silent), matching a known-but-DMARC-failing token. 406 stays
reserved for a genuinely unparseable recipient address (the case Mailgun should stop retrying).
**Consequence:** Closes the token-existence oracle (RT-21) without changing Mailgun's retry
behavior for malformed addresses.

### 14. F-6 — `sending` compare-and-swap state for at-most-once delivery
**Context:** a `delivery.fulfill` retry (timeout, pod eviction) re-ran the whole handler, resending
an already-accepted email.
**Decision:** Mark the `deliveries` row `sending` via CAS immediately before the external call;
a retry that finds `sending` finalizes `sent` without calling the outbound port again.
**Consequence:** At most one send per inbound message, at the cost of occasionally reporting `sent`
for a call whose true provider outcome is ambiguous — judged safer than a possible duplicate send.

### 15. F-4/F-5 — re-check gates at send time; schedule expiry and retention jobs
**Context:** authorization was checked once at webhook time; nothing re-checked it before the
external send minutes-to-hours later, and `file.expire`/`staging.purge`/`inbound.purge` were built
but never enqueued by any production path — expiry didn't expire anything on the default (raw
Zoho link) path.
**Decision:** `delivery.fulfill` re-reads the file and re-evaluates expiry/allowlist immediately
before sending; `files.create`/`updateSettings` now schedule `file.expire`, and a recurring sweep
(`expiry.safety_sweep`) catches anything a scheduling bug might miss.
**Consequence:** A sender's expire/delete/lock-down now actually stops an in-flight request; `/readyz`
reports sweep health so a regression here is observable, not silent.

### 16. Rate-limit keys normalized to the identity being limited, plus a domain bucket
**Context:** `mallory+0@…`/`mallory+1@…` and Gmail dot-insertion multiplied the per-requester
budget without limit; one attacker domain could silently exhaust a file's whole hourly budget.
**Decision:** Strip `+tag` sub-addressing and (for Gmail/Googlemail) dots before bucketing; add a
`RATE_DOMAIN_PER_HOUR` bucket alongside the existing requester/file/tenant buckets, with a fairness
rule so a new domain isn't starved by one dominant domain already at the per-file ceiling.
**Consequence:** A named residual gap remains (rotating across many distinct domains could still
exceed a file's raw budget) — documented in `rate-limit.ts`, not closed, since no pinned test
requires it and the tenant/domain buckets already bound it.

### 17. Webhook body capped before any parsing
**Context:** the multipart branch had no `bodyLimit`/`limits`, so an unauthenticated caller could
make the server buffer up to ~1 GB before the HMAC check even ran.
**Decision:** Explicit `bodyLimit` (`WEBHOOK_BODY_LIMIT_BYTES`, sized just above Mailgun's
documented ceiling) rejects on `Content-Length` before parsing; multipart `limits` stop reading
once the three fields the HMAC check needs have been seen.
**Consequence:** An oversized or lying request is answered 413 without a byte of its body read.

### 18. `INBOUND_REQUESTS_ENABLED` kill switch, independent of code deploys
**Context:** the auth-results field name is still a guess (`@unverified-live`) until a live Mailgun
payload is captured; shipping the wrong guess would silently quarantine every legitimate request.
**Decision:** A config flag (default `true`) that, when `false`, quarantines every
signature-verified webhook before auth-results extraction runs — no deploy needed to hold or
resume the inbound path.
**Consequence:** Live-spike capture (runbook spike 3) can be done safely against a real deployment
without risking an accidental auto-share on an unconfirmed field-name guess.

### 19. Hand-written SQL in repositories, no ORM/query builder
**Context:** the schema is ten tables and ~35 statements, several of which need
`FOR UPDATE SKIP LOCKED`, `pg_advisory_xact_lock`, and a specific `ON CONFLICT` idempotency guard —
constructs most builders force an escape hatch for anyway.
**Decision:** Hand-written SQL per repository method, row types declared next to each query.
**Consequence:** Less machinery to review than a schema-generation step; adopting Kysely later is
mechanical and can be done one repository at a time if the surface grows.

### 20. `eta` over Nunjucks for SSR templates
**Context:** nine views, one RTL shell, no need for a large template-inheritance system.
**Decision:** `eta` — actively released, ships its own types, autoescapes by default.
**Consequence:** Nunjucks 3.2.4 (2023, needs `@types/nunjucks`) would have bought nothing for this
surface; `eta`'s `layout()` covers the single shell this product needs.
