# AI Red Team Report — Swenlly System 2 (file-sharing)

**Owner:** ai-red-team · **Date:** 2026-09-08 · **Branch:** `claude/swenlly-system-2-file-sharing-32nrdu`
**Target:** the unattended inbound-email → file-delivery pipeline (`src/domain/request-pipeline.ts`,
`src/adapters/mailgun/*`, `src/jobs/handlers/delivery-fulfill.ts`, `src/http/routes/{webhook-mailgun,public-share}.ts`).
**Regression cases:** `tests/redteam/` (7 files, 78 cases: 56 passing "blocked" pins, 22 live
findings marked `it.fails` so the suite stays green until trust-safety fixes them).
**Rules of engagement:** no product code changed, nothing committed. `vitest.config.ts` gained
one glob (`tests/redteam/**/*.test.ts`) in the existing `integration` project; no other config touched.

```
TEST_DATABASE_URL=$(scripts/dev-db.sh url | grep TEST_DATABASE_URL | cut -d= -f2-) \
  pnpm exec vitest run tests/redteam --project integration
```

---

## 0. Verdict

**The guardrails do not hold.** The DMARC gate — the single control that research/03 §2 says
makes "share a private file because an email asked for it" shippable at all — is satisfiable by
a header the requester types into their own outgoing message. Everything downstream of it
(AC-R1, AC-R3, and the allowlist) inherits that break.

Everything the team *did* build is genuinely good: gate ordering, the replay index, the
token-only resolver, the 401-writes-nothing property, tenant-slug cross-checking, and the
branded page's leak discipline all survived sustained attack (§3, 56 passing cases). The
failures are concentrated in two places: **what the pipeline treats as trustworthy input**, and
**everything that happens after the pipeline says yes**.

---

## 1. Findings

### F-1 · CRITICAL · The DMARC gate is satisfied by an attacker-supplied message header
**AC broken:** AC-R1, AC-R3. **Repro:** `tests/redteam/auth-gate-bypass.test.ts` → `RT-01`, `RT-01b`, `RT-05`.

`adapters/mailgun/mapping.ts` reads DMARC by probing five guessed key names —
`dmarc`, `Dmarc`, `X-Mailgun-Dmarc-Result`, `dmarc-result`, `Dmarc-Result` — in the **same flat
payload namespace** that carries the message's own MIME headers. Mailgun's inbound routes
"post all MIME headers into the app" alongside its synthetic parameters
([Mailgun — receive/forward/store](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http.md)).
So a requester who adds one line to their outgoing message asserts their own authentication result.

```
From: attacker@no-dmarc-at-all.test
X-Mailgun-Dmarc-Result: pass          <-- typed by the attacker
```

**Observed:** `deliveries.outcome = 'queued'`, `deliveries.dmarc = 'pass'`, `delivery.fulfill`
enqueued — with no SPF, no DKIM, no DMARC record and no aligned domain anywhere.
**Expected:** `quarantined`, reason `dmarc_unknown`.
The same applies to `Spf`, `Dkim` and `Dmarc-Domain`, so gate 6's alignment check is forgeable too.

`RT-05` chains it with F-3 into the full primitive: an attacker with **no domain at all** gets an
allowlist-restricted file mailed to a mailbox they control.

**Fix.** Never read authentication results out of the flattened payload. Two layers:
1. Read DMARC/SPF/DKIM **only** from `message-headers` entries that Mailgun itself stamped, or
   better, from Mailgun's own `Authentication-Results` line, and **strip** every payload key that
   could have originated in the inbound message before mapping (allowlist the ~15 synthetic
   Mailgun field names; discard the rest of the top-level namespace).
2. Verify the field name against a **live captured payload** before launch — architecture.md §12
   already lists this as unverified; it is not a documentation gap, it is the product's only
   authentication gate. Until then, hold the inbound path behind a flag.

---

### F-2 · HIGH · DMARC alignment fails **open** while DMARC itself fails closed
**AC broken:** AC-R3. **Repro:** `tests/redteam/auth-gate-bypass.test.ts` → `RT-02`.

Gate 6 is `if (msg.dmarcDomain && msg.dmarcDomain.toLowerCase() !== fromDomain)`. `dmarcDomain`
comes from three guessed key names. If the provider reports the evaluated domain anywhere else —
including inside `Authentication-Results`, the actual RFC 8601 carrier — the mapper returns
`null` and the alignment check **silently disappears**. `extractDmarc` deliberately fails closed
to `'unknown'` on the identical uncertainty; `dmarcDomain` fails open on it.

**Observed:** payload with `dmarc=pass`, `From: ceo@victim-corp.test`, and the real evaluated
domain under `Authentication-Results` / `X-Mailgun-Dmarc-Evaluated-Domain` → `queued`.
**Expected:** quarantined — a `pass` we cannot align to the `From` domain is not a pass.

**Fix.** Make the alignment field mandatory: if `dmarc === 'pass'` but no *provider-asserted*
evaluated domain can be read, quarantine with reason `dmarc_domain_unknown`. Add a startup
assertion/alarm so "we never see this field" surfaces as an incident, not as silence.

---

### F-3 · HIGH · A `From` address with two `@` bypasses the allowlist
**AC broken:** AC-R3 + the allowlist control (architecture.md §0/§4.8). **Repro:** `RT-04`, `RT-05`.

Nothing validates that the extracted From address is a single well-formed mailbox.
`extractAddresses` accepts anything inside `<...>`, and `fromDomain` is `split('@')[1]` — the
**first** domain-ish segment — while SMTP routes on the **last** `@`.

```
allowlist:  @corp.test
From:       <victim@corp.test@attacker.test>
```
**Observed:** `outcome = 'queued'`, `requester_address = 'victim@corp.test@attacker.test'`.
Control case `attacker@attacker.test` is correctly `not_allowlisted` — so this is a targeted
bypass, not a broken allowlist.
**Expected:** rejected as a malformed From (`from_address_invalid`).

**Fix.** After extraction, require exactly one `@`, no whitespace/quotes/control characters, a
valid ASCII domain (reuse `settings.ts`'s `USER_AT_HOST_RE`), and derive the domain as
`slice(lastIndexOf('@') + 1)`. Quarantine anything else.

---

### F-4 · HIGH · Nothing is re-checked between "authorised" and "delivered"
**AC broken:** AC-U4. **Repro:** `tests/redteam/delivery-toctou.test.ts` → `RT-10`, `RT-11`, `RT-12`.

Gates 8–9 run on the HTTP request; `delivery.fulfill` runs later — after a paced re-share defer,
after exponential backoff (up to 5 min × `JOB_MAX_ATTEMPTS=8`), or after a queue backlog. The
handler re-reads the file row and re-checks **nothing** on it.

| Attack | Observed | Expected |
|---|---|---|
| File expires between enqueue and fulfilment | 1 send, `outcome='sent'` | no send |
| Sender **deletes** the file between enqueue and fulfilment | 1 send, `outcome='sent'` | no send |
| Sender tightens `allowlist_mode` to `allowlist` | 1 send | no send |

The sender's only emergency controls — expire now, delete now, lock down now — do not stop a
request already in flight.

**Fix.** Re-run gates 8–9 inside `delivery.fulfill` against the freshly-read row (status,
`expires_at`, allowlist) and complete the delivery as `expired` / `not_allowlisted` instead of
sending. Cheap: the row is already loaded.

---

### F-5 · HIGH · `file.expire`, `staging.purge` and `inbound.purge` are never scheduled
**AC broken:** AC-U4; architecture.md §7 and §10 retention. **Repro:** `tests/redteam/expiry-and-retention.test.ts` → `RT-50`…`RT-54`.

No production code path calls `jobs.enqueue` for any of these three kinds. The only callers in
the repository are the tests that assert the handlers work — so `tests/integration/expiry.test.ts`
passes by enqueuing the job by hand, and reads as coverage for a control that does not exist.

| Attack | Observed | Expected |
|---|---|---|
| Wait past `expires_at`, run the worker | Zoho public link still live (`revoked = false`) | revoked |
| Same, after a Drive share was granted | Drive permission still granted (`permissionCount = 1`) | revoked |
| Set an expiry | zero `file.expire` rows in `jobs` | one scheduled |
| Pass `RAW_PAYLOAD_RETENTION_DAYS` | raw inbound payloads retained indefinitely | nulled |
| Pass `STAGING_RETENTION_HOURS` | staged blob retained indefinitely | deleted |

This is the sharpest one for the **shipping default**: with `BRANDED_PAGE_ENABLED=false` (AC-U2),
the distribution link *is* the raw Zoho public link. There is no Swenlly code in front of it, so
the request-time expiry checks never run — expiry is enforced only by a revocation that never
happens. **Today, expiry does not expire anything on the default path.**

**Fix.** Enqueue `file.expire` with `runAfter = expires_at` whenever `expires_at` is set or
changed (dedupe key `file.expire:<fileId>:<epochMs>`), and add a periodic tick (a `cron`-kind job
that re-enqueues itself, or the worker loop's idle branch) for `staging.purge` / `inbound.purge`.
Add a `readyz` assertion that the recurring jobs exist.

---

### F-6 · MEDIUM · A `delivery.fulfill` retry re-sends the file
**Repro:** `tests/redteam/delivery-toctou.test.ts` → `RT-13`.

The handler sends first and records second. Any failure after the provider accepted the message
(socket timeout on the response, pod eviction, a transient DB error on `deliveries.complete`)
re-runs the whole handler on retry — including the send.
**Observed:** 2 identical attachment sends for 1 inbound message. **Expected:** 1.

architecture.md §4.2 states the principle already — "replay is re-disclosure, so this is a hard
gate" — but applies it only at the webhook. Apply it at the send too: mark the `deliveries` row
`sending` (with the provider message id) before the call, treat a row that is already
`sent`/`sending` as done on retry, and pass a deterministic idempotency key to the provider.

---

### F-7 · MEDIUM · The pre-authentication quarantine path is unbounded
**Repro:** `tests/redteam/addressing-and-routing.test.ts` → `RT-20`.

Gates 4–6 (slug mismatch, DMARC, From sanity) all write a `deliveries` row **and** an
`inbound_messages` row carrying the full raw payload — and all run **before** gate 7, the only
rate gate. Anyone ever handed a mailto link can therefore write unbounded rows into that
tenant's audit log with an attacker-chosen `requester_address`, plus unbounded raw payloads
retained for `RAW_PAYLOAD_RETENTION_DAYS` (which, per F-5, is forever).
**Observed:** 25 DMARC-fail requests → 25 audit rows with `RATE_REQUESTER_PER_HOUR=3`.

Two harms: unbounded storage growth on an unauthenticated path, and audit-log poisoning — the
sender's deliveries panel becomes an attacker-writable surface.

**Fix.** Move a cheap counter (per `signature_token` source / per file / per tenant) ahead of
gate 4, and collapse repeated identical quarantines into a counter on one row rather than N rows.

---

### F-8 · MEDIUM · Per-requester rate limiting is trivially multiplied
**Repro:** `tests/redteam/rate-limit-evasion.test.ts` → `RT-30`, `RT-30b`, `RT-31`.

The bucket key is the raw address string. `RATE_REQUESTER_PER_HOUR` (default 5) is the control
`docs/lessons.md` records as the answer to request-bombing.

| Attack | Observed | Expected |
|---|---|---|
| `mallory+0..11@relay.test` (one real mailbox), limit 3 | 12 queued | ≤3 |
| Gmail dot-insertion `m.a.l.lory@gmail.com`, limit 2 | 5 queued | ≤2 |
| 6 addresses at one attacker domain vs `RATE_FILE_PER_HOUR=6` | a legitimate requester at another domain is then silently refused | legitimate requester still served |

The third is the damaging one: because "silence is the correct response to a failed request", a
single attacker domain converts a file into an **invisible outage** for every real recipient for
the rest of the hour, and nobody is told.

**Fix.** Normalise the bucket key (lowercase — already done; strip `+tag`; strip dots for known
providers) and add a fourth bucket keyed on the requester **domain**, sized well below the
per-file budget so no one domain can consume it.

---

### F-9 · LOW · The 406/200 split is a token-existence oracle
**Repro:** `tests/redteam/addressing-and-routing.test.ts` → `RT-21`.

architecture.md §4.4 promises "Unknown token → 406, **no disclosure of whether a token ever
existed**". The status code is the disclosure: unknown token → 406, known token (even one that
then fails DMARC) → 200. Mailgun treats the two differently toward the sender — a 406 stops the
route and can surface a delivery-failure notice, a 200 is silent — so the oracle is observable
from outside without ever seeing our response. It only confirms guesses, and the token is 130
bits, so this is a documentation-vs-behaviour defect more than an exploit.

**Fix.** Return 200 for a well-formed-but-unknown token (keep 406 strictly for an unparseable
recipient, which is the case Mailgun should genuinely stop retrying).

---

### F-10 · MEDIUM · No body cap on the public webhook; the multipart branch buffers before auth
**Repro:** `tests/redteam/webhook-abuse.test.ts` → `RT-40`.

architecture.md §10 lists a "body size cap" among the webhook's security properties. The route
sets no `bodyLimit`, and `@fastify/multipart` is registered with no options, so the multipart
branch is bounded only by `parts: 1000` × busboy's 1 MB default field size ≈ **1 GB per request**.
`parseWebhookBody` fully materialises the body **before** gate 1 runs.
**Observed:** a 25 MiB unauthenticated multipart body is parsed in full, then answered 401.
The urlencoded branch is correctly capped at Fastify's 1 MB default (413) — the gap is specific
to the multipart shape, which is exactly the shape Mailgun uses when the message had attachments.

**Fix.** Set `bodyLimit` on the route (Mailgun's inbound payload has a documented ceiling; size
it just above), pass explicit `limits` to the multipart iterator (`parts`, `fieldSize`,
`fields`, `fileSize`), and verify the HMAC from the `timestamp`/`token`/`signature` fields
before draining the remaining parts.

---

### F-11 · LOW · `Message-Id` is stored but never de-duplicated
**Repro:** `tests/redteam/addressing-and-routing.test.ts` → `RT-22`.

The replay gate keys on Mailgun's per-POST `signature_token`, which correctly absorbs webhook
retries. But `provider_message_id` has no uniqueness constraint and nothing else de-duplicates
the *message*, so any path that re-injects the same RFC 5322 message under a fresh signature
(two matching routes, a forwarding/bounce loop, a provider-side re-delivery) re-discloses the
file. **Observed:** 2 queued deliveries for one `Message-Id`.

**Fix.** Add a unique partial index on `(provider_message_id)` where it is non-empty, and treat a
conflict the way `signature_token` is treated — 200, no action.

---

### F-12 · INFORMATIONAL · White-label leaks
**Repro:** `tests/redteam/public-share-surface.test.ts` (both `OBSERVED` cases).

- The global CSP advertises `frame-src https://workdrive.zohoexternal.com` on **every** response,
  including `/s/:slug/download` and the expired page where no iframe is rendered. AC-U3 wants the
  recipient to see "Swenlly", not "Zoho WorkDrive"; the header names Zoho unconditionally.
  Fix: attach that `frame-src` only to the branded-page route.
- Neither public route has any per-IP ceiling (`rateLimit` is registered `{ global: false }` and
  these routes set no `config.rateLimit`). Not exploitable against a 130-bit slug, but it is the
  product's only unauthenticated GET surface.

---

## 2. Severity roll-up

| ID | Severity | Broken | Test |
|---|---|---|---|
| F-1 | **Critical** | AC-R1, AC-R3 | `RT-01`, `RT-01b`, `RT-05` |
| F-2 | High | AC-R3 | `RT-02` |
| F-3 | High | AC-R3, allowlist | `RT-04`, `RT-05` |
| F-4 | High | AC-U4 | `RT-10`, `RT-11`, `RT-12` |
| F-5 | High | AC-U4, retention | `RT-50`–`RT-54` |
| F-6 | Medium | re-disclosure | `RT-13` |
| F-7 | Medium | availability, audit integrity | `RT-20` |
| F-8 | Medium | rate control, availability | `RT-30`, `RT-30b`, `RT-31` |
| F-9 | Low | §4.4 invariant | `RT-21` |
| F-10 | Medium | availability | `RT-40` |
| F-11 | Low | re-disclosure | `RT-22` |
| F-12 | Informational | AC-U3 polish | `OBSERVED` cases |

Also filed as a non-security defect: `From: "victim@corp.test" <attacker@relay.test>` is rejected
as multi-address because `extractAddresses` matches the quoted display name. Safe direction, but
a real requester with an email address in their display name is silently refused forever
(`auth-gate-bypass.test.ts`, "BLOCKED: display-name spoof"). Fix it together with F-3 by parsing
the header properly instead of regex-scraping it.

---

## 3. Attempted and blocked (56 passing regression pins)

**Authentication (`auth-gate-bypass.test.ts`)** — `bestguesspass`, `pass (p=none)`, `permerror`,
empty string, and absent-field all quarantine as `dmarc_unknown`; `pass`/`Pass`/`PASS`/`" pass "`
are accepted (deliberate case/whitespace tolerance, pinned); display-name spoof
`"victim@x" <attacker@y>` and comma-separated multi-address headers are rejected
`from_address_invalid`; an explicitly reported alignment mismatch is caught
`dmarc_domain_mismatch`; case variants of the From address do not evade alignment.

**Addressing (`addressing-and-routing.test.ts`)** — 13 grammar attacks all return `null` from
`parseRequestAddress`: multiple envelope recipients, angle-bracket wrapper, trailing dot on the
domain, `share.swenlly.test.evil.test` suffix, a Cyrillic-`ѕ` homoglyph domain, token ±1
character, a second `+file-` segment appended, omitted slug, missing/`_`/single-`-` separators,
and embedded newlines. The four accepted forms (`+`, `--`, uppercase, surrounding whitespace) are
pinned as intentional. Tenant A's slug with tenant B's token → `tenant_slug_mismatch`, no send,
and tenant A's own file untouched.

**Resolution integrity (AC-R2)** — a request naming another tenant's token, slug, file id, full
request address and `deliver-to:` in the subject and body, plus an attachment whose filename is
`../../etc/passwd` and whose contents are the victim's token, still serves **only** the file in
the envelope address; the victim's file records zero deliveries.

**Destination integrity (AC-R3)** — `Reply-To`, `Sender`, `Return-Path`, `Delivered-To`, `To`,
`Cc`, `Bcc`, `X-Original-From` and Mailgun's own `sender` field are all ignored; the reply goes
to the `From` address and nothing else.

**Signature/replay (AC-R6)** — empty, non-hex, truncated, bit-flipped, uppercase-mutated and
absent signatures, and mutated `timestamp`/`token`, all 401 with **zero** rows written anywhere;
±300 s of skew is accepted and ±301 s is not; exact replay, replay-with-mutated-`From`, and
object-cloned replay all deliver exactly once with the original requester recorded.

**Rate gates** — case variants share one bucket; 10 concurrent distinct signed webhooks from one
requester still yield exactly `RATE_REQUESTER_PER_HOUR` queued (the `INSERT … ON CONFLICT …
RETURNING` counter has no check-then-act window); the tenant bucket caps a spread attack.

**Public surface** — the branded page and the download response leak neither `zoho_public_link`,
`zoho_resource_id` nor `zoho_link_id` in body or headers, and set no `Location`/`Link`; unknown
and expired slugs are byte-identical (200 + expired page, and 410 on download); with the flag OFF
both routes are byte-identical to a missing route; a `<script>` display name is HTML-escaped; a
display name carrying `"\r\nX-Injected:` cannot inject a response header (and undici's `FormData`
escapes the same value on the outbound attachment filename).

**Concurrency** — I wrote no new SharingEngine attacks: the existing
`sharing-engine`/`drive-copies-concurrency` suites (50 racing `share()` calls, injected
crash-after-copy) already exercise the quota boundary harder than I would have, and re-running
the full suite under this pass kept them green. **Not verified by me:** the quota-boundary race
under a *hostile* request mix (many requesters × many files × a Drive quota that flips
mid-transaction) — I judged the existing proof sufficient rather than reproving it.

---

## 4. Verdict per acceptance criterion

| AC | Verdict | Basis |
|---|---|---|
| **AC-R1** DMARC-fail/absent → no delivery, quarantined | **FAIL** | Holds for every value the *provider* can report, but F-1 lets the requester assert `pass` themselves. |
| **AC-R2** File chosen only from `+file-<token>` | **PASS** | Body/subject/attachment/header injection all inert; `files.resolveByRequestToken` is the only resolver. |
| **AC-R3** Delivery to the verified From address only | **FAIL** | F-1 (auth forgeable), F-2 (alignment fails open), F-3 (two-`@` address defeats the allowlist and splits check-domain from delivery-domain). |
| **AC-R4** ≤20 MB attachment / larger via Drive share | **PASS (inherited)** | Verdict rests on the existing `delivery-mechanism.test.ts`, not on a new attack; I only confirmed the Drive-share branch is reachable (`RT-51`). The no-Google-account OTP experience is untestable here and remains architecture.md §12's unverified spike. |
| **AC-R5** Reply uses custom message + display name | **PASS** | Verbatim, no boilerplate prepended; display name safely encoded in both header and attachment filename. |
| **AC-R6** Webhook rejected unless the signature verifies | **PASS with a caveat** | Verification is correct and writes nothing on failure — but F-10 means an unauthenticated caller can make the server buffer up to ~1 GB before that decision. |
| **AC-E1** Auto-duplication at the share cap | **PASS** | No new failure under adversarial concurrency. |
| **AC-U4** Expiry actually removes access | **FAIL** | F-5 (no revocation is ever scheduled; on the default raw-Zoho path there is nothing else enforcing expiry) and F-4 (in-flight requests ignore expiry and deletion). |

**Recommended gate decision:** the inbound email-request path should not go live until F-1, F-2
and F-3 are fixed and F-1's underlying question — *which payload field does Mailgun actually put
the authentication result in* — is answered against a captured live payload rather than a guess.
F-4 and F-5 must land before any customer is told expiry works.

---

## 5. Re-test protocol

Every finding above is a `it.fails` case in `tests/redteam/`. When trust-safety ships a fix, flip
that case from `it.fails` to `it` — it then guards the fix permanently. Do not delete a case to
make the suite green. I will re-attack after the patch set, focusing on: the provider-field
allowlist in `mapping.ts` (does stripping the message-header namespace also strip a field the
pipeline needs?), the re-check inside `delivery.fulfill` (does it introduce a new TOCTOU against
`drive_copies`?), and the new expiry scheduler (can an attacker cause `file.expire` to be
scheduled for someone else's file, or starve it?).
