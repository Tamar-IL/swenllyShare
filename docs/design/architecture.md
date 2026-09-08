# Architecture Brief — Swenlly Share (System 2)

**Owner:** software-architect · **Date:** 2026-09-08 · **Status:** Design gate — see §13 for the
architecture-review verdict.
**Inputs:** `docs/01-prd-file-sharing.md` (authoritative), `docs/05-kickoff-brief.md`,
`docs/design/advisor-consult.md` (adopted — see §0), `docs/design/ux-brief.md`,
`docs/research/03 §2`, `05`, `06`, `08`.
**Audience:** backend-, frontend-, database-, devops-engineer; QA; appsec.

---

## 0. What this brief locks, and the one place it overrides a research doc

The advisor's five calls are **adopted as written**: TS/Node 22 + Fastify + SSR, Postgres for
data *and* queue *and* locks, Mailgun Routes behind `InboundMailPort`, Google Workspace service
account with `drive.file` on a Shared Drive, ports-and-adapters with an enforced honesty
boundary. No flaw found; §2 of the consult is the load-bearing one (AC-E2 is unprovable without
concurrent connections) and everything downstream follows from it.

**One deliberate override, decided not asked (§4.9):** `research/03 §2` mandates an owner
allowlist *and* a confirm-link step before any auto-share. The PRD's AC-R3 model is "deliver to
the DMARC-verified From address only." The PRD wins on precedence, and on the merits: with
DMARC-pass required *and* delivery hard-bound to the From address, the confirm-link defends
exactly the case the DMARC gate already blocks (a forged From — the attacker cannot click a link
sent to the victim's inbox). It is redundant, so **it is not built**. The allowlist is *not*
redundant — it is the only control against "anyone holding the mailto link may fetch the file" —
so it ships as a **per-file opt-in** (`files.allowlist_mode = 'open' | 'allowlist'`, default
`open`, plus `file_allowlist(file_id, pattern)` accepting `user@host` or `@domain`). This is
strictly stricter than the PRD and satisfies `03`'s intent without breaking AC-R3.

---

## 1. Locked stack (exact pins)

Single deployable, single Node process (HTTP + worker in one binary, worker loop toggleable by
env so it can be split later without a code change). No bundler, no SPA, no Redis, no Docker
requirement in dev.

| Dependency | Pin | Why |
|---|---|---|
| Node | `22.x` (`engines: >=22.12`) | Native `fetch`/`FormData`/`File`, stable LTS |
| `typescript` | `5.9.3` | `strict: true`, `noUncheckedIndexedAccess`. **Not 7.x** — the native port is weeks old; a launch build takes the boring compiler |
| `fastify` | `5.12.3` | `app.inject()` = HTTP-level tests with no port flake; schema-first validation |
| `@fastify/cookie` | `11.1.2` | Signed session cookie |
| `@fastify/formbody` | `9.0.0` | SSR form posts |
| `@fastify/multipart` | `10.1.1` | **Streamed** upload → staging disk, never buffered |
| `@fastify/static` | `10.1.3` | `/assets/*` |
| `@fastify/view` | `12.0.0` | SSR render |
| `eta` | `4.6.0` | **Chosen over Nunjucks**: actively released, ships its own types, autoescapes by default, and `layout()` covers our single RTL shell. Nunjucks 3.2.4 is a 2023 release needing `@types/nunjucks`, and its Jinja surface (async filters, loader chains, inheritance trees) buys nothing for 9 pages |
| `@fastify/csrf-protection` | `8.0.1` | Double-submit token on every state-changing form |
| `@fastify/rate-limit` | `11.2.0` | Cheap edge limits (sign-in, webhook); business limits live in Postgres (§4.6) |
| `@fastify/helmet` | `13.1.1` | CSP; `frame-src` allows `workdrive.zohoexternal.com` only |
| `pg` | `8.23.0` | See below |
| `zod` | `4.5.4` | Env parsing + inbound DTO parsing at the trust boundary |
| `pino` | `10.3.1` (+`pino-pretty` `13.1.3` dev) | Structured logs with a redaction list (§10) |
| `google-auth-library` | `11.0.2` | Token minting/refresh + domain-wide delegation. **Not `googleapis`** — we call five Drive endpoints and hand-roll resumable upload anyway; the generated 20 MB client is dead weight |
| `undici` | `8.10.2` | One HTTP client for Drive, Zoho and Mailgun REST (retry/timeout policy in one place). **No Mailgun SDK** — outbound is one multipart POST and native `FormData`/`File` covers ≤20 MB attachments |
| `close-with-grace` | `2.5.0` | Drain HTTP + finish in-flight job before exit |
| `vitest` | `5.0.0` | Test runner; real Postgres, no mocks at the DB layer |
| `tsx` | `4.23.13` (dev) | Dev runner |
| `eslint` `10.10.0` + `typescript-eslint` `8.70.0` + `prettier` `3.9.6` | dev | Lint/format |
| `@types/node` `26.5.0`, `@types/pg` `8.23.1` | dev | Types |

Package manager **pnpm** (lockfile committed, `--frozen-lockfile` in CI).

**No ORM, no query builder.** Every non-trivial statement in this system is SQL a builder would
force us to escape from anyway — `FOR UPDATE SKIP LOCKED`, `pg_advisory_xact_lock`, the
`ON CONFLICT (tenant_id, file_id, intent_seq) DO NOTHING` idempotency guard, and the sliding
window `SUM` over minute buckets. Ten tables, ~35 statements. Hand-written SQL in repositories, with row types
declared next to each query, is less machinery and more reviewable than a schema-generation step. Migrations are numbered `.sql` files, each applied in one transaction by a
60-line `migrate.ts` against a `schema_migrations` table. Adopting Kysely later is mechanical
and per-repository.

---

## 2. Components, boundaries, layout

```
                 ┌────────────────────────── one Node process ──────────────────────────┐
 sender (RTL) ──▶│ HTTP: sender app routes ─┐                                            │
 recipient    ──▶│ HTTP: GET /s/:slug (flag)│                                            │
 Mailgun      ──▶│ HTTP: POST /webhooks/... │──▶ DOMAIN SERVICES ──▶ REPOSITORIES ──▶ PG │
 k8s/monitor  ──▶│ HTTP: /healthz /readyz   │        ▲                                   │
                 │ WORKER LOOP (SKIP LOCKED)┘────────┘        PORTS ──▶ ADAPTERS ──▶ ext │
                 └──────────────────────────────────────────────────────────────────────┘
```

**Boundary rules (enforced by review + a `no-restricted-imports` block per direction in
`eslint.config.js`, one per rule below plus a fourth restricting `pg` itself to the three
locations named in rule 3 — fix pass 4, code review finding 3):**
1. HTTP handlers contain no business logic and no SQL. They parse, authorize, call one domain
   service, render.
2. Domain services never import an adapter — only a port interface, injected by `container.ts`.
3. Only repositories issue SQL. Every tenant-owned repository method takes `tenantId` as its
   first argument and every statement carries `WHERE tenant_id = $1` (§3 invariant).
4. Adapters contain no policy: they translate protocol ↔ DTO and classify errors. The DMARC
   *decision* is domain, the DMARC *field read* is adapter.

**Domain services.** `Files` (create, publish state machine, delete), `Links` (distribution link
resolution, mailto construction, slug/token minting), `Settings` (display name, custom message,
expiry, allowlist), `RequestPipeline` (§4), `SharingEngine` (§5), `Audit`, `RateLimit`,
`Auth` (magic link, sessions, CSRF helper).

**Ports** (`src/ports/`), each with a real adapter and a semantic fake:

| Port | Methods (signature-level) | Real adapter |
|---|---|---|
| `FileStorePort` | `upload(tenantFolder, stream, size, name) → {resourceId}`; `createPublicLink(resourceId, {allowDownload}) → {linkId, url, embedToken}`; `revokeLink(linkId)`; `openDownload(resourceId) → ReadableStream`; `delete(resourceId)` | Zoho WorkDrive REST |
| `DriveSharePort` | `uploadResumable(...) → {driveFileId}`; `copy(driveFileId, intentKey) → {driveFileId}`; `findByIntent(intentKey) → driveFileId?`; `sharePermission(driveFileId, email) → {permissionId}`; `revokeAll(driveFileId)`; `delete(driveFileId)` | Drive v3 via `undici` + SA/DWD |
| `InboundMailPort` | `verify(headers, rawBody) → boolean`; `parse(payload) → InboundMessage` | Mailgun Routes |
| `OutboundMailPort` | `send({to, subject, text, attachment?}) → {providerMessageId}` | Mailgun messages API |
| `BlobStagingPort` | `put(id, stream) → {bytes}`; `open(id) → ReadableStream`; `stat(id)`; `remove(id)` | local disk (`STAGING_DIR`) |
| `Clock` | `now()`, `sleep(ms)` | system / fake with virtual time |
| `TokenGen` | `opaque(bits) → string` (Crockford base32, lowercase) | `crypto.randomBytes` |

Every port has **one contract-test suite** run against both adapters. Without credentials the
real run **reports skipped, never passed**. Each real adapter method carries an
`@unverified-live` / `@verified-live(YYYY-MM-DD)` marker; `docs/verification-ledger.md` is
generated from those markers (§9).

**Worker loop.** `SELECT ... FROM jobs WHERE run_after <= now() AND status='pending' ORDER BY
run_after FOR UPDATE SKIP LOCKED LIMIT 1`, handler dispatch by `kind`, exponential backoff
(`attempts`, `run_after`), dead-letter at `JOB_MAX_ATTEMPTS`. Handlers: `file.publish`,
`delivery.fulfill`, `file.expire`, `drive.revoke`, `staging.purge`, `inbound.purge`.

```
src/
  server.ts app.ts worker.ts container.ts config.ts
  http/
    plugins/{auth.ts,csrf.ts,security-headers.ts,error-handler.ts}
    routes/{signin.ts,files.ts,api-files.ts,public-share.ts,webhook-mailgun.ts,health.ts}
  domain/{files.ts,links.ts,settings.ts,request-pipeline.ts,sharing-engine.ts,
          audit.ts,rate-limit.ts,auth.ts}
  ports/{file-store.ts,drive-share.ts,inbound-mail.ts,outbound-mail.ts,
         blob-staging.ts,clock.ts,token-gen.ts}
  adapters/{zoho,google,mailgun,staging,system}/{real.ts,fake.ts}
  db/{pool.ts,migrate.ts,migrations/0001_init.sql,repositories/*.ts}
  jobs/{queue.ts,loop.ts,handlers/*.ts}
  views/{layout.eta,signin.eta,files-list.eta,file-detail.eta,upload.eta,
         share-page.eta,share-expired.eta,error.eta}
  public/{app.css,island.js}
  lib/{base32.ts,errors.ts,mailto.ts,addressing.ts}
tests/{unit,integration,contract}/…
scripts/{pg-test-cluster.sh,gen-verification-ledger.ts}
```

---

## 3. Data model (high level — DDL to the database-engineer)

Ten tables. Invariants are non-negotiable; column detail, index choice and constraint naming are
the database-engineer's.

- **`tenants`** — `id` (uuid), `slug` (base32, appears in the inbound address), `email` (unique,
  case-folded — **one email = one tenant**), `created_at`.
- **`magic_link_tokens`** — `token_hash` (sha256 of a 130-bit token; the plaintext is never
  stored), `email`, `expires_at` (15 min), `consumed_at`, `requested_ip`.
- **`sessions`** — `id` (128-bit opaque), `tenant_id`, `expires_at` (30-day sliding),
  `last_seen_at`, `user_agent_hash`.
- **`files`** — `id`, `tenant_id`, `display_name`, `original_name`, `size_bytes`, `mime`,
  `zoho_resource_id`, `zoho_link_id`, `zoho_public_link`, `zoho_embed_token`,
  `drive_active_copy_id` (→`drive_copies`), `request_token` (**opaque, 130 bits**, Crockford
  base32, 26 chars, globally unique), `public_slug` (separate 130-bit token — see below),
  `custom_message`, `expires_at` (nullable = no expiry), `allowlist_mode`, `staging_blob_id`,
  `status` (`staged|publishing|ready|expired|deleted|failed`), `created_at`.
- **`file_allowlist`** — `file_id`, `pattern` (`user@host` or `@domain`).
- **`drive_copies`** — `id`, `tenant_id`, `file_id`, `intent_seq` (**unique per
  `(tenant_id, file_id)`**), `drive_file_id`, `intent_key`, `share_count`, `last_share_at`,
  `status` (`provisioning|active|retired|revoked`), `retire_reason`.
- **`inbound_messages`** — `id`, `provider_message_id` (unique), `signature_token` (**unique —
  the replay table**), `recipient_raw`, `tenant_id?`, `file_id?`, `from_address`, `from_domain`,
  `dmarc`, `spf`, `dkim`, `quarantined`, `reason`, `raw_payload` (jsonb), `purge_after`,
  `created_at`.
- **`deliveries`** (the audit log, AC-A2) — `id`, `tenant_id`, `file_id`, `requester_address`,
  `mechanism` (`attachment|drive_share`), `dmarc`, `drive_copy_id?`, `outcome`
  (`queued|sent|failed|quarantined|rate_limited|expired|not_allowlisted`), `reason`,
  `inbound_message_id`, `created_at`, `completed_at`.
- **`rate_limit_counters`** — `bucket_key`, `window_start` (1-minute bucket), `count`,
  PK `(bucket_key, window_start)`. Sliding window = `SUM(count)` over the last N buckets.
- **`jobs`** — `id`, `kind`, `payload` (jsonb), `dedupe_key` (unique, nullable), `run_after`,
  `attempts`, `status`, `last_error`, `locked_at`.

**Fixed invariants**
1. Every tenant-owned row carries `tenant_id`; every statement in a tenant repository filters on
   it. A cross-tenant read requires a different repository, of which there are exactly two
   (`resolveByRequestToken`, `resolveBySlug`), each returning the `tenant_id` it resolved.
2. **`request_token` is the only way an inbound address resolves to a file.** Never the subject,
   never the body, never `To:`, never the tenant slug alone.
3. `request_token ≠ public_slug`. Reusing one token for both surfaces would let a holder of the
   web link derive the inbound address (and vice versa); they are different capabilities with
   different audiences.
4. `deliveries` is append-then-complete: a row exists before the external call, so a crash mid-
   delivery is visible, not invisible.
5. Files are never hard-deleted by expiry — access is revoked; `status` gates every read path.

---

## 4. The inbound request pipeline

`POST /webhooks/mailgun/inbound`. Gates run **in this order**; the first failure writes a
`deliveries` and/or `inbound_messages` row and stops. The requester is never told why (UX brief
§3: silence is the correct response to a failed request).

1. **Signature verify** — HMAC-SHA256 over `timestamp + token` with `MAILGUN_SIGNING_KEY`,
   constant-time compare, timestamp within ±5 min. Fail → **401**, nothing written but a counter.
2. **Replay check** — `INSERT INTO inbound_messages(signature_token, provider_message_id...)`;
   unique violation → duplicate delivery, **200**, no action. Replay is re-disclosure, so this is
   a hard gate, not an optimization.
3. **Envelope-recipient parse** — Mailgun delivers the envelope recipient in the `recipient`
   field; that field alone is authoritative. Grammar (lowercased first):
   `^cust-(?<slug>[a-z0-9]{6,32})(?:\+|--)file-(?<token>[a-z0-9]{26})@<INBOUND_DOMAIN>$`
   We **emit** the `+` form (`cust-<slug>+file-<token>@share.swenlly.com`) and **accept** the
   `--` form as well, because a minority of MUAs and forwarding rules mangle `+`. Mailgun route:
   `match_recipient("^cust-.*@share\.swenlly\.com$") → forward(<webhook>)` — one wildcard route,
   no per-tenant provisioning. Unparseable → **406** (tells Mailgun to stop retrying).
4. **Tenant + file resolve by token** — look up `files.request_token`; then assert the tenant slug
   in the address matches the file's tenant. Mismatch is tampering → quarantine + audit. Unknown
   token → **406**, no disclosure of whether a token ever existed.
5. **DMARC gate** — only `dmarc === 'pass'` proceeds. `fail`, `none`, `unknown`, missing, or
   unparseable → `quarantined = true` + `deliveries.outcome='quarantined'`, **200**, no reply.
   We never re-derive DMARC and never infer pass from absence.
6. **From-address sanity** — exactly one `From` address; reject multiples. The provider must
   report which domain DMARC was evaluated against and it must equal `from_domain` — a `pass`
   with no evaluated domain available at all is quarantined (`dmarc_alignment_unknown`), never
   accepted (F-2 hardening, `docs/security/red-team-report.md`). The delivery address is
   `fromHeaderAddress` and nothing else (AC-R3).
7. **Rate gates** (sliding windows in Postgres, §3): per requester address
   (`RATE_REQUESTER_PER_HOUR`, default 5), per file (`RATE_FILE_PER_HOUR`, 60), per tenant
   (`RATE_TENANT_PER_HOUR`, 300). Exceeded → audit row `rate_limited`, no reply.
8. **Allowlist gate** (only when `allowlist_mode='allowlist'`) → miss = `not_allowlisted`, no reply.
9. **Expiry check** — `status='ready'` and (`expires_at IS NULL OR expires_at > now()`).
   Expired → audit row, no reply.
10. **Enqueue (transactional outbox)** — one transaction inserts the `inbound_messages` update,
    the `deliveries` row (`queued`) and the `jobs` row (`delivery.fulfill`, `dedupe_key =
    inbound_message_id`). Commit → **200**. Nothing external has happened yet, so a crash here
    costs nothing and a retry duplicates nothing.
11. **Worker `delivery.fulfill`** — if `size_bytes <= ATTACH_LIMIT_BYTES` (default 20 MB) **and**
    the staged blob still exists → `OutboundMailPort.send` with the attachment streamed from
    staging; else `SharingEngine.share(tenant, file, requester)` (§5) and send the share link.
    Either way the body is the sender's `custom_message` verbatim, the subject and file name use
    `display_name` (AC-R5), and the `deliveries` row is completed with the mechanism, outcome and
    timestamp. Send failure → job retry with backoff; the audit row stays `queued` until it
    resolves, then `sent` or `failed`.

**Not built, deliberately:** the confirm-link step from `research/03 §2.3` (§0 above). The
allowlist ships as the per-file opt-in described in §0.

---

## 5. SharingEngine — auto-duplication (AC-E1/E2)

```
share(tenant, file, requester):
  # phase 1 — reserve, under mutual exclusion, short transaction
  BEGIN
    SELECT pg_advisory_xact_lock(hashtext('swenlly.share'), hashtext(tenant||':'||file))
    copy := active copy for (tenant,file)            -- intent_seq DESC, status='active'
    if copy is null:                     copy := provision(next_seq)      # holds the lock
    if copy.share_count >= DRIVE_SHARE_SOFT_CAP:                          # proactive
                                         copy := provision(copy.intent_seq + 1)
    if now() - copy.last_share_at < SHARE_PACE_MIN_INTERVAL_MS:
        reschedule job at last_share_at + interval; COMMIT; return        # paced re-share
    copy.share_count += 1 ; copy.last_share_at = now()
  COMMIT
  # phase 2 — the external call, outside the lock
  try   DriveSharePort.sharePermission(copy.drive_file_id, requester)
  catch QuotaClass:                                                       # reactive
        BEGIN advisory_lock; retire(copy,'quota'); provision(copy.intent_seq+1); COMMIT
        retry once on the new copy; a second QuotaClass → job backoff
  record deliveries.outcome
```

- **Advisory lock, not a row lock**: it serializes the *decision* even when the rows it protects
  do not yet exist (the first copy). Namespaced two-argument form so `hashtext` collisions across
  key spaces cause only redundant serialization, never a missed exclusion.
- **Locks give mutual exclusion, not idempotency.** `provision(seq)` therefore:
  1. `INSERT INTO drive_copies (tenant_id, file_id, intent_seq, status='provisioning', intent_key)
     ON CONFLICT (tenant_id, file_id, intent_seq) DO NOTHING` — a loser re-reads and reuses.
  2. `DriveSharePort.findByIntent(intent_key)` first — the copy is created with
     `appProperties.swenllyIntent = <tenant>:<file>:<seq>`, so a crash between `files.copy` and
     `COMMIT` is recovered by lookup instead of creating a third copy.
  3. `files.copy` → store `drive_file_id`, `status='active'`, retire the predecessor.
  The `files.copy` call happens **while holding the advisory transaction lock** (bounded by a 30 s
  HTTP timeout) — the one place we accept an external call inside a transaction, because
  double-provisioning is the failure we most want to exclude and the belt-and-braces
  (`intent_seq` unique + `intent_key` lookup) makes even a lost lock safe.
- **No hard-coded ceiling.** `DRIVE_SHARE_SOFT_CAP` (default 500) is a *margin* trigger below the
  opaque, velocity-based real limit (`research/05 §1`); correctness comes from classifying the
  error — HTTP 403 with `errors[].reason ∈ {sharingRateLimitExceeded, rateLimitExceeded,
  userRateLimitExceeded}` — as `QuotaClass` in the adapter and reacting. `share_count` is a soft
  counter: over-counting (a reserved slot whose API call failed) is harmless; under-counting is
  not, so we reserve before the call.
- **Paced re-share** (`research/05 §1`): after provisioning, shares on the new copy are spaced by
  `SHARE_PACE_MIN_INTERVAL_MS` (default 1500 ms) so a burst does not re-trigger the velocity
  detector on the fresh file. Pacing defers a job; it never drops a request.

**How AC-E1/E2 are proven** (`tests/integration/sharing-engine.test.ts`, real Postgres, pool of 8):
50 `share()` calls fired concurrently with `Promise.all` on distinct connections, against the
fake `DriveSharePort` configured to throw `sharingRateLimitExceeded` at exactly N permissions per
file. Assertions: (a) all 50 requesters end with a working permission on some copy — no raw quota
error surfaces (AC-E1); (b) `SELECT count(*) FROM drive_copies` equals `ceil(50/N)` — at most one
copy per intent, no overshoot (AC-E2); (c) no copy holds more than N permissions; (d) `intent_seq`
values are contiguous. A second test injects a crash after `files.copy` but before commit, reruns,
and asserts exactly one Drive file exists for that intent.

---

## 6. Upload path

Browser `POST /api/files` (multipart, XHR from the island for progress) → `@fastify/multipart`
streams the part directly to `BlobStagingPort.put()` (local disk in MVP; path configurable), with
a hard byte cap at `MAX_UPLOAD_BYTES` (**default 250 MB**, config — fix pass 5, F-G,
`docs/reviews/critic-report.md`: the corroborated Zoho WorkDrive simple-upload ceiling;
raise it once spike 1, `docs/runbooks/live-spikes.md`, confirms the >250MB chunked-upload
shape, or set `ZOHO_LARGE_UPLOAD_ENABLED=true` once a founder has explicitly accepted that
risk — the UX brief's "5 GB" is a placeholder pending the Zoho plan limit — founder fork
§12). Row inserted `status='staged'`,
`file.publish` job enqueued, response returns immediately with the file id; the per-file page
polls `GET /api/files/:id/status` until `ready`.

`file.publish` worker, each step skipped if its result column is already set (crash-safe, no
compensation needed):
1. Zoho chunked upload → `zoho_resource_id`.
2. Drive resumable upload into the tenant's folder in the Shared Drive → `drive_copies`
   `intent_seq = 0`, `status='active'`, `drive_active_copy_id` set.
3. Zoho `POST /api/v1/links` → `zoho_link_id`, `zoho_public_link`, `zoho_embed_token`.
4. `status='ready'`.
Terminal failure after `JOB_MAX_ATTEMPTS` → `status='failed'`, surfaced on the file page with a
retry action.

**Staging retention.** Files `<= ATTACH_LIMIT_BYTES` keep the staged blob for the life of the
file — it is the attachment source, and re-downloading from Zoho at ~100–250 KB/s per request is
worse in every dimension. Files above the limit have their blob purged by `staging.purge`
`STAGING_RETENTION_HOURS` (default 24) after the file reaches `ready` or terminal `failed` — the
window exists so a failed publish can be retried without re-upload. Disk budget ≈ (20 MB ×
active small files) + (24 h of large uploads); when that stops fitting, the fix is one adapter
(S3/R2 behind `BlobStagingPort`), not a redesign.

---

## 7. Links, the branded page, expiry

- **Distribution link** = `Links.distributionUrl(file)`:
  `BRANDED_PAGE_ENABLED=false` (default) → `file.zoho_public_link` (AC-U2).
  `true` → `${PUBLIC_BASE_URL}/s/<public_slug>` (AC-U3).
- **Branded page** (`GET /s/:slug`): SSR Eta, wordmark + `display_name`, embed
  `<iframe src="https://workdrive.zohoexternal.com/embed/<zoho_embed_token>?toolbar=false&appearance=light">`.
  The raw Zoho URL appears **nowhere** in the HTML, headers, or JSON. The download button posts to
  `GET /s/:slug/download`, which **streams** bytes through the server
  (`FileStorePort.openDownload`, `Content-Disposition: attachment`) rather than redirecting — a
  302 would put the Zoho URL in the address bar and fail AC-U3. Bandwidth cost is accepted while
  the flag is off by default; a CDN in front of that route is the scale answer.
  When the flag is off, `/s/*` returns 404 (the slug simply is not advertised).
- **Mailto** (UX brief §3): `mailto:cust-<slug>+file-<token>@<INBOUND_DOMAIN>?subject=<pct>&body=<pct>`,
  subject `בקשה לקבל קובץ: <display name>`, body the three Hebrew lines from the brief, CRLF
  encoded as `%0D%0A`, whole string percent-encoded with `encodeURIComponent` semantics.
- **Expiry (AC-U4)** enforced in **two** places: at the access layer (branded page, download,
  pipeline gate 9 — all check `status`/`expires_at` on every request) and by the `file.expire`
  job scheduled at `expires_at`, which calls `FileStorePort.revokeLink(zoho_link_id)`, enqueues
  `drive.revoke` per copy (`revokeAll` on each `drive_file_id`), and sets `status='expired'`.
  Belt (job) and braces (request-time check) because the Zoho revoke is the one step that depends
  on an unverified external endpoint. Delete = immediate expiry + blob removal + Drive/Zoho object
  deletion.

---

## 8. Auth

Magic-link only. `POST /signin` → mint 130-bit token, store **sha256 hash** with a 15-minute TTL,
mail the plaintext link, and always render the same "check your mail" page (no enumeration).
`GET /auth/callback?token=` → constant-time hash lookup, reject if consumed or expired, mark
consumed, create session, 302 to `/files`. Tenant is created on first successful sign-in — one
email = one tenant (UX brief §0 assumption, adopted; multi-seat is out of MVP).

Session: opaque 128-bit id in cookie `swy_sess` — `httpOnly`, `Secure` (outside dev), `SameSite=Lax`,
signed with `SESSION_SECRET`, `Path=/`, 30-day sliding expiry refreshed at most once per hour.
CSRF: `@fastify/csrf-protection` double-submit token in every state-changing form and in the
island's XHR header; the webhook route is exempt (it authenticates by HMAC) and lives on a
separate path prefix so the exemption is one line, not a per-route flag. `@fastify/rate-limit`
caps sign-in requests per IP and per email (`RATE_MAGICLINK_PER_HOUR`, default 5).

---

## 9. Config & modes

`config.ts` parses `process.env` through a zod schema at boot and **fails fast** — no lazy
`process.env` reads anywhere else.

```
NODE_ENV PORT LOG_LEVEL PUBLIC_BASE_URL INBOUND_DOMAIN
DATABASE_URL PGPOOL_MAX=10 PG_SSL=false
SESSION_SECRET COOKIE_SECURE
ADAPTERS=fake|real            ADAPTER_OVERRIDES="drive=fake,zoho=real"   # dev only
BRANDED_PAGE_ENABLED=false
ATTACH_LIMIT_BYTES=20971520   MAX_UPLOAD_BYTES=262144000   # fix pass 5, F-G: 250MB, not 1GB
STAGING_DIR                   STAGING_RETENTION_HOURS=24
DRIVE_SHARE_SOFT_CAP=500      SHARE_PACE_MIN_INTERVAL_MS=1500
DEFAULT_EXPIRY_DAYS=30
RATE_REQUESTER_PER_HOUR=5 RATE_FILE_PER_HOUR=60 RATE_TENANT_PER_HOUR=300 RATE_MAGICLINK_PER_HOUR=5
RATE_DOMAIN_PER_HOUR=30
RAW_PAYLOAD_RETENTION_DAYS=7  QUARANTINE_PER_TOKEN_PER_HOUR=5
GOOGLE_CREDENTIAL_MODE=service_account|oauth_refresh  GOOGLE_SA_JSON_PATH
GOOGLE_IMPERSONATE_SUBJECT GOOGLE_SHARED_DRIVE_ID GOOGLE_ROOT_FOLDER_ID
GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_OAUTH_REFRESH_TOKEN  # oauth_refresh mode
ZOHO_CLIENT_ID ZOHO_CLIENT_SECRET ZOHO_REFRESH_TOKEN ZOHO_API_BASE ZOHO_TEAM_FOLDER_ID
ZOHO_ACCOUNTS_BASE ZOHO_LINK_ROLE_ID=6 ZOHO_LARGE_UPLOAD_ENABLED=false  # fix pass 5, F-G
MAILGUN_API_BASE MAILGUN_API_KEY MAILGUN_SIGNING_KEY MAILGUN_SENDING_DOMAIN OUTBOUND_FROM
MAILGUN_AUTHSERV_ID           INBOUND_AUTH_SOURCE=mailgun-fields      # fix pass 5, F-B: required with
INBOUND_REQUESTS_ENABLED=false                              # ADAPTERS=real or in production
WEBHOOK_BODY_LIMIT_BYTES=2097152
WORKER_ENABLED=true WORKER_CONCURRENCY=4 JOB_MAX_ATTEMPTS=8
```

`ADAPTERS=fake` gives a full demo/dev run with no credentials. **The app refuses to boot with any
fake adapter when `NODE_ENV=production`** — a hard throw in `container.ts`, covered by a test.
`pnpm gen:ledger` regenerates `docs/verification-ledger.md` from the `@unverified-live` /
`@verified-live(date)` markers in `src/adapters/**`; CI fails if the committed file differs from
the generated one, so the honesty ledger cannot drift. Every founder-facing summary states the
live-call count (**currently zero**).

---

## 10. Security notes (for the appsec pass)

- Webhook: HMAC verify before any parsing; `signature_token` unique index is the replay table;
  ±5-minute timestamp window; body size cap.
- Token entropy: 130 bits for `request_token`, `public_slug`, magic-link tokens; 128 for session
  ids; all from `crypto.randomBytes`, Crockford base32, url- and mailto-safe, no ambiguous chars.
  Magic-link tokens stored hashed; the other two are capabilities that must be readable back.
- Raw inbound payload retained `RAW_PAYLOAD_RETENTION_DAYS` (default 7) for debugging spoofing
  reports, then nulled by the `inbound.purge` job (the row and its audit fields survive).
- Log redaction list in pino: `authorization`, `cookie`, `signature`, `token`, `request_token`,
  `public_slug`, `*_refresh_token`, `MAILGUN_*`, request bodies on `/signin` and the webhook.
  Requester addresses are logged at `info` (they are the audit subject) but never tokens.
- Tenant scoping per §3; the two cross-tenant resolvers are the only exceptions and both are
  token-authenticated.
- CSP via helmet: `default-src 'self'`, `frame-src https://workdrive.zohoexternal.com`,
  `script-src 'self'` (the island is a file, no inline JS), `object-src 'none'`,
  `frame-ancestors 'none'`.
- Uploads: no user-supplied path ever touches the filesystem — staging ids are generated;
  `Content-Type` is recorded, never trusted; downloads always `Content-Disposition: attachment`
  with a sanitized filename.
- Secrets from env/secret-manager only; none in the repo; `.env.example` carries names, not values.

---

## 11. Build order and the route contract (B and C run concurrently)

**Lane A — foundation (blocking, ~first).** pnpm workspace, tsconfig strict, `config.ts`, `db/pool`,
`migrate.ts` + `0001_init.sql` (all ten tables), repositories with tenant-scoped signatures,
`scripts/pg-test-cluster.sh`. Unblocks B and D.

**Lane B — backend (after A).** Ports + fakes first (they are the contract), then domain services,
then real adapters, then the worker loop and job handlers. Order inside B: `Auth` → `Files`/upload
→ `Links` → `RequestPipeline` → `SharingEngine`.

**Lane C — frontend (starts with A, in parallel with B).** Eta layout + RTL CSS, all nine views,
the single vanilla-JS island (`public/island.js`: XHR upload with progress + cancel, copy-to-
clipboard with the "הועתק" swap, status polling, deliveries polling). **C codes against the route
table below and the fake-adapter server** (`ADAPTERS=fake pnpm dev`), so it never waits on B.

**Lane D — devops (parallel).** Postgres test-cluster script, CI (typecheck → lint → unit →
integration on real PG → ledger check), Dockerfile/process manifest, healthchecks.

**Route table — the seam. Frozen once agreed; changes go through the architect.**

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/` | cookie | — | 302 `/files` or `/signin` |
| GET | `/signin` | — | — | HTML |
| POST | `/signin` | csrf | form `email` | HTML "check your mail" (always 200) |
| GET | `/auth/callback` | — | `?token` | 302 `/files` or HTML error+resend |
| POST | `/signout` | session+csrf | — | 302 `/signin` |
| GET | `/files` | session | — | HTML list |
| GET | `/files/new` | session | — | HTML upload |
| POST | `/api/files` | session+csrf | multipart `file` | 201 `{fileId, status:"staged"}`; 413 `{error:"too_large", maxBytes}` |
| GET | `/api/files/:id/status` | session | — | `{status, publishStep, error?}` |
| GET | `/files/:id` | session | — | HTML per-file page |
| POST | `/files/:id/settings` | session+csrf | form `displayName, customMessage, expiryMode(none\|days\|custom), expiryDays?, expiresAt?, allowlistMode, allowlist?` | 302 back with flash |
| POST | `/files/:id/delete` | session+csrf | — | 302 `/files` |
| GET | `/api/files/:id/deliveries` | session | `?since` | `{items:[{address, mechanism, outcome, at}], total}` |
| GET | `/s/:slug` | public | — | HTML branded page / expired page; 404 when flag off |
| GET | `/s/:slug/download` | public | — | streamed bytes; 410 when expired |
| POST | `/webhooks/mailgun/inbound` | HMAC | Mailgun form payload | 200 accepted/ignored · 401 bad signature · 406 unroutable |
| GET | `/healthz` `/readyz` | — | — | `{ok}` / `{ok, db, pendingJobs}` |

Every JSON error body is `{error: <code>, message?: <string>}` with codes from `lib/errors.ts`.

---

## 12. Top tradeoffs, risks, and what I did not verify

1. **Branded page depends on two whitelistings we don't control** (`swenlly.com` *and*
   `workdrive.zohoexternal.com`). Mitigated structurally: flag OFF by default, raw Zoho link is
   the shipping path, `/s/*` 404s when off. Nothing in Lanes A–B depends on it.
2. **AC-R4 depends on a founder fork.** Visitor sharing (open with no Google account via email
   OTP) is a Workspace admin feature; on a consumer Gmail central account AC-R4 degrades to
   "recipient needs a Google account." `DriveSharePort` supports both credential modes, but this
   is a *product* change, not a config one → escalated (PRD §10.4).
3. **Single stateful deployable.** Local-disk staging means one node until `BlobStagingPort` gets
   an object-store adapter; the worker in-process means a slow job can starve HTTP under load.
   Accepted for MVP (both are one-adapter / one-env-var changes); the alternative buys nothing at
   this scale and costs a queue service we deliberately refused.
4. **`files.copy` runs inside a transaction holding the advisory lock** (§5) — an unusual choice.
   Bounded by a 30 s timeout and made safe-if-lost by the `intent_seq` unique constraint plus the
   `appProperties` recovery lookup. Reviewed as the lesser evil against double-provisioning.
5. **Silent failure for legitimate DMARC-failing senders** (UX brief §3). Deliberate — replying
   confirms the address exists — but it is a real support cost. Ships with the sender-facing note
   on the file page; a manual "it didn't arrive" path is a PM/founder question, not built.

**Not verified (zero live external calls have been made by anyone on this project):** Zoho
WorkDrive API access on the founder's plan, the create-link/revoke-link/chunked-upload shapes and
their `role_id` mapping; Google Drive visitor sharing and the real share ceiling; Mailgun's
`recipient` field semantics for a plus-addressed catch-all and the exact auth-results field names;
whether `workdrive.zohoexternal.com` renders inside NetFree. All four are the kickoff brief's P0
spikes and all four are isolated behind ports, so a wrong guess costs one adapter. Also unverified
here: nothing has been compiled or run — the dependency pins were resolved against the registry
but no install has happened.

---

## 13. Architecture-review gate — **PASS**

Every acceptance criterion maps to a named component and a named test. No AC lacks an owner.

| AC | Component that satisfies it | Test that proves it |
|---|---|---|
| AC-U1 | `Files.create` + `Links` + per-file page | `integration/upload-flow`: upload → page renders distribution link, mailto with the file's token, editable settings |
| AC-U2 | `Links.distributionUrl`, flag off | `unit/links` + `integration/file-page` (flag off ⇒ link === `zoho_public_link`) |
| AC-U3 | `GET /s/:slug` + streamed `/download` | `integration/branded-page`: flag on ⇒ swenlly.com URL, HTML contains "Swenlly" + the zohoexternal iframe, and asserts `zoho_public_link` appears in no response body or header |
| AC-U4 | request-time gates + `file.expire` job | `integration/expiry`: virtual-clock advance ⇒ page expired, download 410, pipeline audits `expired`; fake ports assert revoke + permission removal |
| AC-R1 | Pipeline gate 5 | `integration/inbound-dmarc`: `fail`/`none`/absent ⇒ zero outbound sends, `quarantined` audit row |
| AC-R2 | Pipeline gate 3–4 (envelope only) | `integration/inbound-injection`: body/subject naming another file ⇒ the token's file is delivered, nothing else |
| AC-R3 | Pipeline gate 6 + `delivery.fulfill` | `integration/inbound-happy`: reply address === From; a `Reply-To`/body third address is ignored |
| AC-R4 | `delivery.fulfill` branch on `ATTACH_LIMIT_BYTES` | `integration/delivery-mechanism` at 19/21 MB ⇒ attachment vs `drive_share`. *Live no-Google-account open is a manual spike, not automatable* |
| AC-R5 | `Settings` + reply composer | `unit/reply-composer`: body === `custom_message` verbatim, subject/filename use `display_name` |
| AC-R6 | `MailgunInboundAdapter.verify` | `integration/webhook-signature`: bad/absent/expired/replayed signature ⇒ 401 or ignored, no side effects |
| AC-E1 | `SharingEngine` reactive quota handling | `integration/sharing-engine` (§5): 50 concurrent, fake throws `sharingRateLimitExceeded` ⇒ all succeed |
| AC-E2 | advisory lock + `intent_seq` unique + intent-key recovery | same test, copy-count and no-overshoot assertions + the crash-mid-provision case |
| AC-A1 | file-scoped Drive permissions, per-file Zoho links, no folder grants | `integration/isolation`: a delivery grants exactly one permission on one file; no folder/account grant is ever requested of the fake |
| AC-A2 | `deliveries` + `GET /api/files/:id/deliveries` | `integration/audit`: every terminal path (sent, quarantined, rate-limited, expired) writes a queryable row with mechanism, DMARC, timestamp |
| AC-A3 | tenant-scoped repositories + session auth | `integration/tenant-isolation`: tenant B requesting A's file id/slug/settings gets 404, never 403-with-detail |

**Verdict: PASS.** The design is buildable without further design decisions; the open items are
all *external verification* (§12), each isolated behind a port, plus two founder forks below.
**Re-review is required if** any of these changes: the Google credential mode (fork 1), the
branded-page download strategy, or the decision to co-locate the worker in the HTTP process.
