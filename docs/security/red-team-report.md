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

---

## 6. Fix status (backend-engineer pass, 2026-09-08)

All 22 `it.fails` regression cases in `tests/redteam/` are flipped to `it` and pass, alongside
the full existing suite (`pnpm test` — 269 passed, plus 5 pre-existing `it.fails` in
`tests/qa/**` that belong to a separate QA pass, not this one). No red-team test was deleted or
weakened; two non-redteam integration tests and one redteam assertion that encoded the exact
bug being fixed were corrected (noted below) so their expectations match the fixed behavior
rather than the vulnerability. Details, decisions, and what was not verified are in this
session's backend-engineer report; this section is the finding-by-finding summary.

**Addendum — F-2/F-12 hardening pass (same day, follow-on session):** F-2's disagreement was
resolved (quarantine a domain-less `pass`, per orchestrator decision) and F-12's CSP sub-finding
was fixed now that `security-headers.ts` was back in remit. See those two findings' entries below
for what changed; every other finding's status below is unchanged from the original pass.

### F-1 · CRITICAL · fixed, then re-opened and re-fixed (fix pass 5, F-B)
`src/adapters/mailgun/mapping.ts` no longer probes guessed key names for DMARC/SPF/DKIM — this
much has held since the pass below. But the critic gate (`docs/reviews/critic-report.md`, F-B)
found the fix as originally written closed only one of four realistic forgery payload shapes: the
top-level "degraded fallback" performed no `authserv-id` check at all, and the anti-forgery guard
both sources depended on was inoperative whenever `message-headers` was simply absent — a
contemplated, documented condition, not exotic. **The property that now holds, stated with its
precondition (fix pass 5):** DMARC/SPF/DKIM are trusted ONLY when Mailgun's `message-headers`
array is present in the payload — from Mailgun's own synthetic top-level fields (`dmarc`, `spf`,
`dkim`, `dmarc-domain`, tried first) or a `message-headers` `Authentication-Results` entry whose
`authserv-id` exactly matches the REQUIRED config `MAILGUN_AUTHSERV_ID` (never defaulted to
`INBOUND_DOMAIN`, which is public and guessable — the exact value the critic's forged payloads
exploited). When `message-headers` is absent, every auth field reads `unknown` and the request is
quarantined, full stop — the old top-level-only `Authentication-Results` fallback was deleted
entirely, not hardened, because it was never reachable safely. `INBOUND_AUTH_SOURCE`
(`authentication-results|mailgun-fields|both`, default `both`) selects which recognized source(s)
run; `INBOUND_REQUESTS_ENABLED` now defaults `false` (was `true`) — a kill switch built for an
unverified assumption defaults to the safe position.
Tests: `RT-01`, `RT-01b`, `RT-05` (auth-gate-bypass.test.ts) + `tests/unit/mailgun-mapping.test.ts`
(both the original `message-headers`-path coverage and, since fix pass 5, a dedicated "critic four
probe payloads A-D" suite at both the mapper and pipeline level —
`tests/review/dmarc-gate-payloads-a-d.test.ts`).
**Still `@unverified-live`** — this is a mapping-logic fix proven against synthetic payloads, not
a live-payload confirmation. The field-name guess remains a guess until spike 3 is actually run;
`INBOUND_REQUESTS_ENABLED=false` holds the path shut until it is.

### F-2 · HIGH · fully fixed (orchestrator decision, 2026-09-08 hardening pass)
The root-cause bug (alignment silently skipped because `dmarcDomain` extraction failed to find
the domain even when the provider reported it) was fixed by F-1's mapping rewrite: `dmarcDomain`
is correctly read from `Authentication-Results`, so gate 6's alignment check actually fires
(RT-02). A prior pass here stopped short of this finding's own stronger "Fix" recommendation —
quarantine whenever `dmarc === 'pass'` but no domain can be read AT ALL — because it broke
`auth-gate-bypass.test.ts`'s `SANITY`/`DOCUMENTED` cases, which sent `dmarc: 'pass'` with no
domain field at all and asserted delivery succeeds. That was flagged as an unresolved
disagreement between this finding's narrative and those pins.
**Resolved:** per PRD precedence rule 4 (safety/consent invariants may only be made stricter, not
looser), the orchestrator decided in favor of this finding's original recommendation. Gate 6
(`src/domain/request-pipeline.ts`) now quarantines `dmarc === 'pass'` with no evaluated domain
at all — reason `dmarc_alignment_unknown` — as a step BEFORE the existing mismatch check, which
is unchanged. `SANITY`/`DOCUMENTED` were not weakened to accommodate this: they were corrected,
because a domain-less `pass` was never a realistic payload to begin with — a genuine provider
`pass` always carries the domain it evaluated (that's what `header.from=` in a real
`Authentication-Results` header is). Both now supply one via a proper `Authentication-Results`
header (`tests/setup/webhook.ts`'s new `authenticationResultsHeader()` helper) instead of a bare
`dmarc: 'pass'` field with no domain — matching what a real pass looks like, not loosening what
they test. Every existing attack-case assertion in the file is unchanged; a new case,
`BLOCKED (F-2 hardening): dmarc=pass with NO evaluated domain...`, pins the newly-stricter
behavior directly. `buildSignedWebhookPayload`'s shared `dmarc: 'pass'` option now auto-supplies
an aligned `Authentication-Results` header by default (so every OTHER test across the suite that
asks for a plain `pass` happy path keeps getting a realistic one, with zero changes needed at
those call sites) — a test wanting the domain-less case specifically bypasses that option and
sets `payload.dmarc` by hand, as the two `SANITY`/`DOCUMENTED`/new cases now do.
architecture.md §4 gate 6's wording was updated to state the domain-less-quarantine rule.
Test: `RT-02` passes unchanged; `SANITY`/`DOCUMENTED`×5 pass on corrected (realistic) payloads;
new `BLOCKED (F-2 hardening)` case pins the fix. Full suite: `pnpm test` — 284 passed, 7 skipped,
zero `it.fails` anywhere in `tests/`.

### F-3 · HIGH · fixed
New `src/lib/email-address.ts`: a hand-written RFC 5322-ish mailbox parser (display names,
quoted strings, parenthesized comments, comma-separated lists) replacing the old
bracket/bare-address regex. Requires exactly one `@` in the addr-spec (rejects the two-`@`
bypass), derives the domain from the LAST `@`, IDN-normalizes via `url.domainToASCII`, and
rejects a display name that itself looks like an address (the display-name-spoof case — see
disagreement note below). `mapping.ts` uses it for `From`, and cross-checks Mailgun's own `from`
field when present, rejecting on disagreement (`RT-03`). The same normalized address is used for
delivery, the allowlist check, and (via `addressDomain()`) the rate-limit domain bucket.
**Disagreement, resolved in favor of the pinned test:** the report's closing note suggests this
fix should let a real requester who puts an email address in their display name through
("parsing the header properly instead of regex-scraping it"). I kept the CURRENT
reject-when-display-name-looks-like-an-address behavior instead, because the pinned
`"BLOCKED: display-name spoof..."` test in the same file asserts rejection with reason
`from_address_invalid` — a genuinely correct RFC 5322 parse would accept it as one address with a
decorative name, which would flip that pinned test. I judged the defensive reject worth keeping
(a display name containing a full email address is itself a classic spoofing pattern) at the cost
of the false-positive the report names; noted in `email-address.ts`'s own doc comment.
Tests: `RT-04`, `RT-05` (chained), `RT-03`; `BLOCKED: display-name spoof` and
`BLOCKED: <victim>, <attacker>` (two-address) unchanged; new `tests/unit/email-address.test.ts`.

### F-4 · HIGH · fixed
`src/jobs/handlers/delivery-fulfill.ts` re-reads the file fresh and re-evaluates expiry/status
and the allowlist immediately before the external send, completing the delivery
`expired`/`not_allowlisted` instead of sending if either now fails. Tests: `RT-10`, `RT-11`,
`RT-12`.

### F-5 · HIGH · fixed
`files.create`/`files.updateSettings` (`src/db/repositories/files.ts`) now call
`jobs.scheduleExpire` whenever `expires_at` is set, changed, or cleared — dedupe key
`expire:<fileId>`, always reset to `pending` on a change (RT-52). `src/jobs/queue.ts`'s new
`ensureSweepsScheduled` enqueues `staging.purge`/`inbound.purge`/`expiry.safety_sweep`
(deduped per 15-minute window, reactivating a `done` job for a new window's work instead of
`enqueue`'s one-shot `DO NOTHING`) — called at the start of `runPendingJobs` (so tests exercise
real scheduling, not hand-enqueued jobs) and from a dedicated low-frequency loop in
`src/jobs/loop.ts`'s `startWorkerLoop`. `expiry.safety_sweep` is a new job kind
(`src/jobs/handlers/expiry-safety-sweep.ts`) that catches any `ready` file past `expires_at`
with no scheduled job — the belt for the scheduling belt-and-braces. `/readyz` now reports
`sweepsHealthy` and each sweep kind's last-scheduled time. Tests: `RT-50`, `RT-51`, `RT-52`,
`RT-53`, `RT-54`; new `tests/integration/readyz.test.ts` and `jobs.test.ts` additions.
**Implementation note surfaced along the way (not a red-team finding, fixed as part of this
work):** `jobs.claimNext`'s "is this job due" check compared against Postgres's real `now()`,
which cannot be advanced by a test's `FakeClock.advance()` — a job scheduled from a future point
on the injected clock (exactly what `scheduleExpire` does) would never become claimable in a
test that only advances virtual time. Fixed by giving `claimNext` an optional `now` parameter;
`processNextJob` passes `max(injected clock, real Date.now())`, so ordinary immediate jobs are
unaffected (real time still decides) while a job's own future clock-relative schedule can be
reached by advancing that same clock.

### F-6 · MEDIUM · fixed
New `outcome = 'sending'` (migration `0002_delivery_sending_state.sql`, widening the
`deliveries_outcome_check` constraint) set via a compare-and-swap
(`deliveryFulfillment.markSending`, `src/db/repositories/delivery-fulfillment.ts`) immediately
before the external send call. A retry that finds a delivery already `sending` does NOT call the
outbound port again — it finalizes `sent` directly, re-deriving the mechanism deterministically.
`sent` itself is a no-op on any further retry. A `SharingEngine` pacing defer (no external call
made) reverts `sending` back to `queued` so the rescheduled attempt runs the normal path, not a
false finalize. Test: `RT-13`.
**Deviation from this finding's literal "goes to `failed`...unless a definite non-send" note:**
`RT-13`'s scenario is exactly a non-definite (ambiguous, "socket hang up after the provider
accepted the message") failure, and the pinned assertion requires the FINAL outcome to be `sent`,
not `failed`. I implemented "found `sending` on a fresh attempt → finalize `sent`, never resend"
uniformly, since resolving an ambiguous in-flight state toward `sent` (accepting a small risk of
an inaccurate status) is strictly safer than `failed` (which some other design might retry and
risk a genuine duplicate send) or leaving it stuck. `queue.ts`'s existing dead-letter hook
(`runDeadLetterHook`, unchanged) still marks a delivery `failed` if its job exhausts
`JOB_MAX_ATTEMPTS` outright — that path is what actually implements a hard-failure terminal
state; RT-13's own 2-attempt scenario never reaches it. I did not add typed
"port reported a definite non-send" classification for the outbound send call specifically — no
pinned test requires it and the existing `PortError` taxonomy (`src/ports/errors.ts`) is
available for a future adapter to use if that distinction becomes load-bearing.

### F-7 · MEDIUM · fixed
Every pre-authentication quarantine write (`RequestPipeline.quarantine`, the shared path for
gate 4's tenant-slug-mismatch, gate 5's DMARC failure, and gate 6's From-sanity failures) is now
capped per resolved request-token, per hour, via a Postgres counter
(`quarantine-token:<token>` in `rate_limit_counters`, config `QUARANTINE_PER_TOKEN_PER_HOUR`,
default 5) — beyond the cap the counter still increments (cheap) but no `inbound_messages`/
`deliveries` write happens; the caller still answers 200 either way. Test: `RT-20`.
**Not implemented:** the `@fastify/rate-limit` per-IP layer this finding's report text also
suggests. The webhook route already has `@fastify/rate-limit` at 600/min (pre-existing,
unrelated to this finding), and no pinned test asks for a stricter per-IP cap specifically —
the per-token Postgres cap is what RT-20 exercises and is IP-independent (correct for a webhook
whose real caller is always Mailgun's own infrastructure, not the attacker's IP).

### F-8 · MEDIUM · fixed
`src/domain/rate-limit.ts`'s requester bucket key strips a `+tag` sub-address and, for
`gmail.com`/`googlemail.com` only, strips dots (RT-30, RT-30b). A new global per-domain-per-hour
bucket (`RATE_DOMAIN_PER_HOUR`, default 30) is checked alongside the existing three. For RT-31's
specific scenario (one domain saturating a single file's own small budget), the per-file check
adds a fairness rule: a request is let through past the raw `RATE_FILE_PER_HOUR` ceiling if its
own domain's share of that file's traffic so far is at most half — a dominant domain gets no such
exception (keeping `RATE_FILE_PER_HOUR: many distinct requesters...still trip the per-file limit`
passing unchanged, same domain, no fairness question to arbitrate), but a new domain always gets
through even when an existing dominant domain has already consumed the raw limit. This fairness
rule is documented in `rate-limit.ts` as a deliberate design choice with a named residual gap
(rotating across many distinct domains could still exceed a file's raw budget) — no pinned test
requires closing that gap and `RATE_TENANT_PER_HOUR`/`RATE_DOMAIN_PER_HOUR` still bound it.
Tests: `RT-30`, `RT-30b`, `RT-31`; existing rate-limit tests (case-folding, concurrent requests,
tenant-bucket, cross-file) all still pass unchanged.

### F-9 · LOW · fixed, differently from this finding's own literal wording
Gate 4's unknown-token path now returns 200 (silent, writes nothing) instead of 406 — matching a
known token that later fails some other gate, which was already 200. 406 stays reserved for gate
3's genuinely unparseable recipient. Test: `RT-21`.
This finding's summary line above ("F-9: ... return 406 for both") is inconsistent with both the
finding's own detailed "Fix" paragraph (which says the opposite: 200 for unknown-token, 406 kept
for unparseable) and with what `RT-21` actually needs (it compares a known-but-failing request,
already 200, against an unknown token — making them match requires the unknown token to become
200). Implemented per the finding's detailed paragraph and the pinned test, not the summary line.
One non-redteam integration test asserted the old 406-for-unknown-token behavior directly
(`tests/integration/inbound-injection.test.ts`); updated it to assert 200, with a comment
explaining why — it was pinning the exact oracle this finding exists to close.

### F-10 · MEDIUM · fixed
`POST /webhooks/mailgun/inbound` now sets `bodyLimit: WEBHOOK_BODY_LIMIT_BYTES` (default 2 MiB)
and checks `Content-Length` explicitly before parsing anything (the route's core `bodyLimit`
does not by itself cap the multipart branch, since `@fastify/multipart` streams outside
Fastify's core body-parsing path) — a request whose declared length exceeds the cap is answered
413 without reading a single byte. `parseWebhookBody`'s multipart branch also now passes explicit
`limits` to `request.parts()` and stops reading further parts as soon as `timestamp`/`token`/
`signature` have all been seen (Mailgun's own stable, documented fields), so even a request that
lies about `Content-Length` never has its junk fields read. Test: `RT-40`.
One non-redteam-labeled-but-adjacent test in the same file ("OBSERVED: the multipart branch
accepts and fully buffers...") explicitly pinned the PRE-fix 401 behavior, with its own comment
saying the fix should make it visibly change — updated to assert 413, per that comment's own
stated intent, not left contradicting `RT-40` in the same file.

### F-11 · LOW · fixed
`inboundMessages.insertOrDuplicate`'s `INSERT ... ON CONFLICT` no longer names `signature_token`
as the sole arbiter — `ON CONFLICT DO NOTHING` (no target) now catches a violation of either
unique index (`signature_token` OR the pre-existing `provider_message_id` unique index from
migration 0001 — that index already existed; the bug was the `ON CONFLICT` clause not covering
it, so a `provider_message_id` collision fell through as an uncaught exception instead of the
graceful `{duplicate: true}` the method's own doc comment always promised). No new migration was
needed for uniqueness itself. Test: `RT-22`; `tests/integration/inbound-messages-replay.test.ts`'s
"provider_message_id is also unique" test previously asserted the old THROWING behavior
(demonstrating the bug, not guarding against it) — updated to assert the graceful dedupe.

### F-12 · INFORMATIONAL · CSP sub-finding fixed; rate-limiting sub-finding left as-is, deliberately
**CSP `frame-src` leak — fixed (2026-09-08 hardening pass):** `src/http/plugins/security-headers.ts`
is no longer out of remit, so the cheap half of this finding is closed. The global CSP no longer
names `https://workdrive.zohoexternal.com` unconditionally — `registerSecurityHeaders` now takes
`BRANDED_PAGE_ENABLED` and only adds `frame-src` when the flag is on. With the flag off (the
default, until a customer's domain is whitelisted per architecture.md §7), `frame-src` is absent
entirely and CSP falls back to `default-src 'self'`, which already blocks the Zoho frame outright
— nothing is lost, since `public-share.ts` 404s `/s/:slug` unconditionally while the flag is off
anyway. This is a genuine improvement to the observed behavior in the common (flag-off) case, so
`tests/integration/security-headers.test.ts`'s existing CSP test was updated to build its
container with `BRANDED_PAGE_ENABLED: true` (so it still exercises the frame-src directive) and a
new test pins the flag-off case (no `frame-src`, no `zohoexternal.com`, anywhere in the header).
The `OBSERVED` `frame-src` pin in `public-share-surface.test.ts` was **not** changed — it already
builds its container with `BRANDED_PAGE_ENABLED: true`, so its observed behavior (frame-src still
present while the flag is genuinely on and the branded page can render) is correctly unchanged by
this fix; noting that explicitly since the general instruction was to touch an `OBSERVED` pin only
when the fix changes what it observes for the better, and here it does not, for that specific case.
**Rate-limiting sub-finding — still not fixed, deliberately:** adding a per-IP ceiling to
`/s/:slug`/`/s/:slug/download` would flip the pinned `"OBSERVED: neither public route is
rate-limited..."` test (currently asserting no 429 ever fires). Not exploitable against a 130-bit
slug, no capability/token/URL leak, and out of scope for a "cheap fix" pass — left as originally
scoped, matching the file's own stated non-exploitability. That `OBSERVED` test is unchanged and
still passes, documenting current (unfixed) behavior as originally intended.
