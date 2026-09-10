# Critic Report — Swenlly System 2 (final Step 4 gate)

**Owner:** critic · **Date:** 2026-09-08 · **Branch:** `claude/swenlly-system-2-file-sharing-32nrdu`
**Question asked:** is this actually good work, and will it hold up when the founder runs the live
spikes and puts real customers on it?
**Method:** read the full doc chain (PRD, kickoff brief, research/03, design gate, all four
reviewer reports, ADRs, runbooks) then attacked the code. Ran `pnpm test` at HEAD: **316 passed,
7 skipped, 56 files, zero failures.** Wrote three throwaway probes (two vitest, one direct call
into `mapMailgunInboundPayload`) to test claims rather than trust them; all three are deleted and
nothing in `src/**` was touched or committed.

---

## Verdict: **FIX-FIRST**

Not RETHINK. The architecture is right, the concurrency work is genuinely excellent, and the
honesty infrastructure (verification ledger, `@unverified-live` markers, live-spikes runbook,
lessons ledger) is better than most funded startups ever build. But **three defects will bite
real customers within days of going live, two of them are proven below with reproductions, and
one of them is currently described as "fixed" in three separate founder-facing documents.**

Fix F-A, F-B and F-C before the live spikes. F-D is a founder decision that must be asked, not
assumed. Everything else can ride along.

---

## Fatal (ship-blocking)

### F-A · Any transient mail-provider error permanently drops the file and records it as `sent`
**Severity: fatal.** **Reproduced.**
`src/jobs/handlers/delivery-fulfill.ts:174-196` (attachment) and `:202-235` (Drive share) ·
`src/jobs/queue.ts:142-151` · `src/db/repositories/delivery-fulfillment.ts`

The F-6/code-review-finding-2 fix introduced `queued → sending → dispatching → sent`.
`markDispatching` fires immediately before `outboundMail.send`, and any later attempt that finds
`dispatching` finalizes the row `sent` with `reason: 'ack_lost'` **without ever calling the
outbound port again**. That is correct for the one scenario it was designed against (the provider
accepted the message and only the ack was lost). It is wrong for every other failure of that same
call — a Mailgun 5xx, a 429, a DNS blip, a socket timeout on connect. Those are *definite
non-sends*, and they are the common case in production.

Reproduction (throwaway test, since deleted): fire one valid inbound request; make
`outboundMail.send` throw once with a transient error; let the job retry.

```
after attempt 1 outcome = dispatching
after attempt 2 outcome = sent   reason = ack_lost
mails actually sent = 0
```

The requester never receives the file. The sender's "מי קיבל את הקובץ" panel — which the UX brief
§4 names *"the load-bearing trust mechanism"* — says it was delivered. The job's entire retry and
dead-letter budget is dead code for the outbound call. On the Drive-share branch it is worse:
`dispatching` spans **two** external calls, so a failed reply email after a successful Drive
permission is also recorded as `sent`.

The red-team fix note anticipated exactly this and declined it: *"I did not add typed 'port
reported a definite non-send' classification — no pinned test requires it."* "No pinned test
requires it" is not a reason; it is a description of the test gap.

**Do this:** classify the failure in the outbound adapter (`src/ports/errors.ts` already has the
taxonomy). A `PermanentError`/`TransientError` raised from a *completed HTTP exchange* means the
provider definitively did not accept — revert `dispatching → queued` and let the job retry. Only a
genuinely ambiguous failure (request written, no response) may finalize `ack_lost`. Better still,
pass a deterministic idempotency key (`delivery:<deliveryId>`) to Mailgun so a resend is safe and
the ambiguous case stops needing a guess at all. Add a test that fails the send itself, not the
blob read.

> **Fix pass 5 status: FIXED.** `src/ports/errors.ts` adds `AmbiguousSendError`.
> `src/adapters/mailgun/real.ts` classifies every failure: a completed non-2xx exchange is a
> definite non-send (unchanged); a `fetch` rejection is `TransientError` only for
> never-connected codes (ECONNREFUSED/ENOTFOUND/EAI_AGAIN/…), `AmbiguousSendError` otherwise
> (no response, or an unrecognized shape). `outboundMail.send` now carries a `deliveryId`,
> stamped as a deterministic `v:swenlly-delivery` custom variable + `Message-Id`.
> `src/jobs/handlers/delivery-fulfill.ts`: a definite non-send reverts `dispatching -> sending`
> and rethrows (job-level retry/backoff/dead-letter applies); only an `AmbiguousSendError` or a
> bare process crash (no error ever classified) finalizes — as the new outcome `unconfirmed`
> (migration `0004`), rendered "לא מאומת", never `sent`. The Drive-share path now has an
> independent `granted` CAS step (`markGranted`) between the permission grant and the reply
> email, so a reply failure after a successful grant retries only the reply, never re-shares.
> Tests: `tests/review/delivery-fulfill-classification.test.ts` (all four scenarios named in
> this finding), `tests/redteam/delivery-toctou.test.ts` RT-13 (rewritten — the ambiguous
> case now asserts `unconfirmed`, not `sent`), `tests/contract/mailgun-wire.test.ts` (network
> classification + idempotency fields).

---

### F-B · The DMARC gate is still forgeable — F-1 is closed for one payload shape out of four
**Severity: fatal.** **Reproduced.**
`src/adapters/mailgun/mapping.ts:163-171, 175-190, 199-216` · `src/config.ts:155` ·
`src/container.ts:183` · `.env.example`

I called `mapMailgunInboundPayload` directly with four payloads. Config: `authservId` =
`share.swenlly.com` (the `container.ts:183` fallback — i.e. `INBOUND_DOMAIN`, a value printed in
every mailto link the product hands out), `authSource: 'both'` (the default).

| # | Payload | Result |
|---|---|---|
| A | No `message-headers`; attacker's own `Authentication-Results:` MIME header with a **bogus** authserv-id (`totally-made-up.evil.test`) | `dmarc = pass`, aligned domain accepted |
| B | No `message-headers`; attacker's own `dmarc: pass` + `dmarc-domain:` headers | `dmarc = pass` |
| C | `message-headers` present, Mailgun stamps no `Authentication-Results` of its own, attacker's A-R names the (public, guessable) authserv-id | `dmarc = pass` |
| D | `message-headers` present with a genuine `dmarc=fail` on top and the attacker's `pass` below | `dmarc = fail` — **defense holds** |

Three findings, all in code that is documented as closed:

1. **`extractFromTopLevelAuthResultsField` (`:163-171`) performs no authserv-id check at all.**
   The primary path matches the authserv-id; the degraded fallback trusts any
   `Authentication-Results` value verbatim. The weaker path is the *less* validated one.
2. **The anti-forgery guard is inoperative whenever `message-headers` is absent.** Both sources
   defend themselves by checking `knownHeaderNames` — a set derived from `message-headers`. No
   `message-headers`, no set, no guard. The module's own doc comment states that `message-headers`
   may be absent "from this payload/plan/route config," so this is a contemplated, not exotic,
   condition.
3. **Source (a) outranks source (b) (`:199-216`).** Priority is backwards from a trust
   standpoint: a value that *could* be an attacker's MIME header wins over the provider's own
   synthetic field.

And the mitigation that was supposed to cover all of this is off: **`INBOUND_REQUESTS_ENABLED`
defaults to `true`** (`config.ts:155`) and does not appear in `.env.example` at all — nor do
`INBOUND_AUTH_SOURCE`, `MAILGUN_AUTHSERV_ID`, `RATE_DOMAIN_PER_HOUR`,
`QUARANTINE_PER_TOKEN_PER_HOUR` or `WEBHOOK_BODY_LIMIT_BYTES`. The deploy runbook's production
checklist never mentions it. A founder who copies `.env.example` and follows
`run-and-deploy.md` will go live with an unverified, forgeable authentication gate wide open and
no idea the switch exists.

**Honest impact, not inflated.** This is *not* a direct file-exfiltration primitive: delivery is
hard-bound to the parsed `From` address (AC-R3 holds structurally), so forging `From` sends the
file to the victim, not the attacker. The real harms are:
- **Outbound abuse.** Anyone holding a mailto link can make Swenlly email a customer's file — up
  to a 20 MB attachment, wrapped in the customer's own message, from Swenlly's sending domain —
  to arbitrary third-party addresses, bounded only by `RATE_TENANT_PER_HOUR` (300/hr). For a
  company whose entire thesis is *"email is the transport that survives the filter,"* burning the
  sending domain's reputation is close to existential. This is `research/03 §3`'s own argument,
  pointed back at System 2.
- **The allowlist control is bypassable**, which matters because ADR 6 dropped the confirm-link
  partly on the strength of the allowlist (see F-D).
- **The audit log lies.** `deliveries.dmarc = 'pass'` is not a fact; it is a requester assertion.

**Do this, in order:**
1. **Default `INBOUND_REQUESTS_ENABLED=false`** until spike 3 flips it, add all six missing vars
   to `.env.example`, and add a line to the production checklist. One-line change; removes the
   whole exposure window.
2. Refuse to trust *any* auth result when `message-headers` is absent — the guard is inoperative,
   so the honest verdict is `unknown` (quarantine), consistent with `docs/lessons.md`'s own rule
   *"a guard whose input is optional must fail closed."*
3. Require an authserv-id match on the top-level fallback too, or delete that fallback.
4. Flip the priority: prefer the provider's synthetic field set, fall back to `Authentication-
   Results`.

**Test-quality note tied to this.** `tests/unit/mailgun-mapping.test.ts:96` — *"mailgun-fields
source still works when the field is NOT duplicated in message-headers"* — sends a payload with
**no `message-headers` at all** and asserts `dmarc === 'pass'`. It pins attack B as intended
behaviour. There is no test anywhere for `extractFromTopLevelAuthResultsField`, the least-validated
branch in the file. The suite proves the guard fires when it can fire; it never asks what happens
when it cannot.

> **Fix pass 5 status: FIXED, all four "Do this" items.** (1) `INBOUND_REQUESTS_ENABLED`
> defaults `false`; `.env.example` gets all six missing vars plus a drift-detection unit test
> (`tests/unit/env-example-sync.test.ts`) so a future addition that forgets the file fails CI.
> (2) `message-headers` absent ⇒ `extractAuthResult` returns `unknown`/`null` for everything,
> full stop, before either source runs. (3)/finding 1: the top-level `Authentication-Results`
> fallback is deleted entirely (not merely authserv-id-gated) — it was never reachable safely
> once (2) fails closed on its one legitimate use case. (4)/finding 3: priority flipped —
> Mailgun's synthetic fields (source b) tried first, `Authentication-Results` (source a)
> second. `MAILGUN_AUTHSERV_ID` is now required config (`loadConfig` cross-field check)
> whenever `ADAPTERS=real` or `INBOUND_REQUESTS_ENABLED=true` in production, and
> `container.ts` no longer falls back to `INBOUND_DOMAIN`. The pinned test at
> `mailgun-mapping.test.ts:96` is corrected (asserts `unknown`, with an explanatory rename)
> and a dedicated test now covers the exact `extractFromTopLevelAuthResultsField` gap this
> finding names — moot, since that function no longer exists. All four probe payloads A-D are
> added as tests at both the mapper (`tests/unit/mailgun-mapping.test.ts`) and pipeline level
> (`tests/review/dmarc-gate-payloads-a-d.test.ts`): A/B/C quarantine `dmarc_unknown`, D still
> resolves `fail` (the defense that already held keeps holding). `run-and-deploy.md`'s
> production checklist gets the kill switch + `MAILGUN_AUTHSERV_ID` + spike-3 gate, and item 4
> (F-H) is corrected in place.

---

### F-C · Expiry can fail permanently and silently on the shipping default path
**Severity: fatal (before customers) / serious (before spikes).** **Reproduced.**
`src/jobs/queue.ts:66-100` · `src/jobs/handlers/expiry-safety-sweep.ts:19-23` ·
`src/db/repositories/jobs.ts` (`enqueue`, `ON CONFLICT ... DO NOTHING`) ·
`src/db/repositories/files.ts:254-271`

With `BRANDED_PAGE_ENABLED=false` (the shipping default), the distribution link **is** the raw Zoho
public link. No Swenlly code sits in front of it, so the request-time expiry checks never run —
`FileStorePort.revokeLink` is the *only* thing that enforces AC-U4 on that path. That call is
`@unverified-live`, against a guessed endpoint shape with a community-sourced `role_id` default.

If it fails, the failure is unrecoverable and invisible:
- `handleFileExpire` throws → `jobs.fail` → after `JOB_MAX_ATTEMPTS` the job is `dead`.
- `runDeadLetterHook` has branches for `file.publish` and `delivery.fulfill` only. **No branch for
  `file.expire`** — nothing is recorded, nothing is surfaced.
- `expiry.safety_sweep` re-finds the file (still `ready`, past `expires_at`, no
  `pending`/`processing` job) and calls `jobs.enqueue` with dedupe key `expire:<fileId>` — which
  hits `ON CONFLICT DO NOTHING` against the still-present `dead` row and does nothing. Forever.

Reproduction (throwaway test, since deleted): make `revokeLink` throw permanently, advance 31 days
of virtual time, run the sweep six times.

```
expire job: [{"kind":"file.expire","status":"dead","attempts":2}]
file status after 6 sweep rounds: ready
```

Consequences: the raw Zoho link stays live past its advertised expiry indefinitely; the
`drive.revoke` jobs for every previously-granted Drive permission are never enqueued, so every
prior recipient keeps access; `/readyz`'s `sweepsHealthy` is green (the *sweep* is fine — the
per-file job is dead); the sender's UI shows the file expired. The product tells the customer
"expired" and the file is still public. That is the single worst failure mode this product can
have, and it is one wrong URL path away.

**Do this:** (a) have the sweep use `jobs.ensureScheduled`-style upsert semantics that reactivate a
`dead`/`failed` expire job rather than colliding with it; (b) add a `file.expire` dead-letter hook
that records the failure and surfaces it — a `/readyz` counter of stranded expiries and a badge on
the file page; (c) never silently leave a file `ready` past `expires_at`. Add a regression test
that fails `revokeLink` permanently and asserts the system notices.

> **Fix pass 5 status: FIXED, all three items.** (a) `jobs.ensureScheduled` reactivates
> `done`/`dead`/`failed` rows (was `done` only), and both `expiry.safety_sweep` and
> `scheduleExpire` now call it. `listExpiredWithoutScheduledJob` also gained a second clause
> (`status = 'expired' AND expiry_error IS NOT NULL`) — without it a file already flipped to
> `expired` (see next point) would never be rediscovered by the sweep at all. (b) A `file.expire`
> branch was added to `runDeadLetterHook` (`src/jobs/queue.ts`), writing a new
> `files.expiry_error` column (migration `0005`); surfaced as `/readyz`'s `strandedExpiries`
> count and a warning badge on the file-detail page. (c) `handleFileExpire` now flips `status`
> to `expired` and enqueues every `drive.revoke` job FIRST, unconditionally — both idempotent,
> both independent of the `revokeLink` call that follows and may still fail/retry/dead-letter.
> Test: `tests/review/expiry-cannot-strand.test.ts`, the exact scenario in this finding's
> re-check protocol line — asserts `expired`, `drive.revoke` enqueued, `strandedExpiries === 1`,
> the expire job reactivated to `pending` (not `dead`), and the marker clearing once the
> underlying failure is fixed. One caught-in-the-act regression from this fix pass itself is in
> `docs/lessons.md` (2026-09-08, jobs repository) — a real-vs-injected-clock race the first
> version of this fix introduced and a few repeated test runs caught.

---

## Serious

### F-D · The confirm-link removal is no longer justified, and it was a founder decision taken by the architect
`docs/design/architecture.md §0` · `docs/decisions.md` ADR 6 · `docs/research/03 §2` ·
`docs/05-kickoff-brief.md` ("Invariants in `docs/research/03` may only be made stricter")

`research/03 §2` rates forged-request file disclosure **Critical** and lists six mandatory controls
"defense in depth — **all of these, not one**," including (2) an owner-curated allowlist with
unknown senders falling to manual approval, and (3) a confirmation link for first-time or
non-allowlisted requesters. The build ships: DMARC (forgeable per F-B, and unverified against any
live payload), rate limits, audit log. It **drops** the confirm-link and **downgrades** the
allowlist to per-file opt-in defaulting to `open`.

The architecture doc labels this *"One deliberate override, decided not asked."* Steelmanning it
properly: the redundancy argument is genuinely good. *If* DMARC-pass is required and delivery is
hard-bound to the `From` address, a confirm-link defends only the case DMARC already blocks — an
attacker cannot click a link that lands in the victim's inbox. That reasoning is sound.

It is also **conditional on a gate that does not hold and that nobody has ever verified against a
live payload.** The confirm-link is the one control in `research/03`'s list that is completely
independent of Mailgun's field naming: it works whether the DMARC data is right, wrong, absent, or
forged. Dropping it removed precisely the control that would have made the inbound path shippable
*before* spike 3 rather than after it.

Two things are wrong here and they are different:
- **The engineering call is now unsupported.** Restoring a confirm-link for non-allowlisted
  requesters would close F-B's abuse vector outright and decouple launch from an unverifiable
  third-party field name.
- **The governance call was not the architect's to make.** The kickoff brief locks `research/03`
  as one-way-stricter-only and instructs: *"if you think a decision is wrong, say so and wait."*
  This was documented but not waited on. It belongs in the founder's open-questions list, and it
  is not there — PRD §10 and README's open-questions section both omit it entirely.

**Do this:** raise it to the founder as an explicit fork — *"research/03 mandates a confirm-link;
we dropped it on a redundancy argument that the red team has since undermined. Restore it, or
accept the risk on the record?"* Then either restore it or record the acceptance. Do not leave it
resolved-by-omission.

> **Fix pass 5 status: NOT IN SCOPE.** The orchestrator carried this forward explicitly as a
> founder fork rather than assigning it to this fix pass — no code or governance change was
> made here. It remains an open decision: restore the confirm-link for non-allowlisted
> requesters, or record the founder's acceptance of the risk on the record. Everything else in
> this fix pass (F-B in particular) narrows, not widens, the gap this finding is about.

### F-E · AC-U3's proof depends on a property of the fake that the real adapter contradicts
`src/adapters/zoho/fake.ts:60-66` · `src/adapters/zoho/real.ts` (`extractOrDeriveEmbedToken`,
`:89-97`) · `src/http/routes/public-share.ts:31`

AC-U3 requires that "the raw Zoho link never appears as the visible destination," and
`tests/integration/branded-page` asserts `zoho_public_link` appears in no body or header. It
passes. The fake makes it pass *by construction*: `embedToken = nextId('embed-tok')`, with a
comment stating it is "**deliberately** NOT derived from `resourceId`... a real embed token is an
opaque Zoho identifier."

The real adapter's fallback, when Zoho's response carries no `embed_url` field — which the
live-spikes runbook flags as one of the most important open facts spike 1 can settle — is
`new URL(plainUrl).pathname.split('/').pop()`: **the last path segment of the raw public link**.
If that fallback fires in production, the branded page's iframe `src` carries the exact token
needed to reconstruct the raw Zoho URL, and the AC-U3 assertion becomes false while the test stays
green. The fake asserts a fact about Zoho that this project has explicitly never verified, and the
real code's own fallback contradicts it.

**Do this:** make spike 1 record whether `embed_url` exists as its headline output; until it does,
have `createPublicLink` return `embedToken: null` on the derive path and have `/s/:slug` refuse to
render rather than embed a derived token. Add a test that asserts the branded page contains no
substring of `zoho_public_link` (not just the whole string).

> **Fix pass 5 status: FIXED.** `extractOrDeriveEmbedToken` (renamed `extractEmbedToken`) no
> longer has a derive path at all — it returns `null` when no `embed_url`/`embed_link` field is
> present, never a value read from `plainUrl`. `FileStorePort.createPublicLink`'s type is now
> `embedToken: string | null`. `GET /s/:slug` (`src/http/routes/public-share.ts`) renders the
> branded page WITHOUT an iframe when `zoho_embed_token` is null — filename, download button,
> and a "preview unavailable" line (`share-page.eta`) — never a fallback to the raw link. Test:
> `tests/redteam/public-share-surface.test.ts`'s new case forces a null embed token through the
> real publish flow (`FakeFileStore.forceNullEmbedTokenOnNextLink()`, a new test seam) and
> asserts no substring of `zoho_public_link`'s own path, at least 12 characters long, appears
> anywhere in the response body or headers — stronger than the whole-string check the sibling
> leak test already had. `docs/runbooks/live-spikes.md` spike 1 now makes "does the create-link
> response carry an embed token/URL" its headline output, with the `null` case documented as
> expected/correct behavior, not something to fix.

### F-F · Three founder-facing documents state F-1 is closed; it is not
`README.md:110-112` · `docs/security/red-team-report.md §6 F-1` · `docs/decisions.md` ADR 11 ·
`docs/progress.md` (2026-09-08 lanes B2+C entry)

- README: *"Read only from Mailgun's `Authentication-Results` entry or an allowlisted field set —
  never the flat namespace attacker-controlled MIME headers also occupy."* Attacks A and B read
  from exactly that namespace.
- ADR 11 consequence: *"Closes the full auth bypass (RT-01/RT-05)."* It closes RT-01's payload
  shape, not the class.
- progress.md: *"auth results from `Authentication-Results` only."* Source (b) is live by default.
- The red-team fix status does carry the honest caveat — but four paragraphs below a bolded
  **"F-1 · CRITICAL · fixed"** heading, and the caveat is about *field naming*, not about the
  guard being inoperative.

This is the one place the project's otherwise exemplary honesty discipline slipped, and it slipped
on the single most important security claim in the product. The pattern to notice: every one of
these statements describes *the fix that was written*, not *the property that now holds*. Those are
different claims and only the second one is worth writing down.

**Do this:** rewrite all four to the property, with its precondition — e.g. *"DMARC is read only
from a provider-stamped `Authentication-Results` entry whose authserv-id matches ours; when
Mailgun's `message-headers` array is absent the verdict is `unknown` and the request is
quarantined."* Then make that sentence true (F-B fix 2).

> **Fix pass 5 status: FIXED.** All four rewritten to state the property and its precondition,
> essentially the critic's own suggested sentence: README's security-model bullet, ADR 11's
> consequence line (with an appended correction, not an edit of the original), progress.md's
> B2+C entry line, and red-team-report.md §6 F-1's fix-status paragraph. And per the "then make
> that sentence true" instruction: F-B's fix makes it true.

### F-G · `MAX_UPLOAD_BYTES` defaults to 1 GB while everything above 250 MB is invented code
`src/config.ts:73` · `src/adapters/zoho/real.ts` (`uploadLargeFile`, "modeled, not confirmed")

The `>250 MB` Zoho upload path is described by its own author as *"the single most speculative
piece of code in this codebase — every field name is a hypothesis."* The shipping default routes
real customer files into it at 250 MB. A sender who uploads a 400 MB video watches the upload
succeed, then watches `file.publish` fail eight times and land on "ההעלאה נכשלה."

**Do this:** default `MAX_UPLOAD_BYTES` to the *corroborated* simple-upload ceiling (250 MB) and
raise it only after spike 1 confirms the large-file shape. The UI already renders the cap from
config, so the sender is told the truth before they pick a file.

> **Fix pass 5 status: FIXED, and hardened further.** `MAX_UPLOAD_BYTES` now defaults to
> 262,144,000 (250 MB). Beyond the critic's own recommendation: the real Zoho adapter's
> `upload()` now REFUSES (`PermanentError`, no request attempted) any file that would need the
> unverified large-file path unless a new `ZOHO_LARGE_UPLOAD_ENABLED` flag (default `false`) is
> explicitly set — so even a stale/misconfigured `MAX_UPLOAD_BYTES` above 250 MB can no longer
> silently route a real customer file into invented code. `.env.example`, README, and
> `architecture.md §6/§9` updated with the new default and a one-line note that it rises after
> spike 1. Test: `tests/contract/zoho-workdrive-wire.test.ts`'s new refusal case (no request
> sent, `PermanentError` thrown) plus the existing large-file wire-shape test now opts in
> explicitly.

### F-H · `run-and-deploy.md` item 4 is factually wrong about the DMARC gate
`docs/runbooks/run-and-deploy.md:60-65`

*"SPF, DKIM and DMARC all published [for `INBOUND_DOMAIN`] — the inbound pipeline's DMARC gate
rejects everything if these aren't in place."* The gate evaluates the **requester's** `From`
domain. `INBOUND_DOMAIN`'s own records govern *outbound* deliverability and are important for that
reason — but publishing them has no effect whatsoever on whether inbound requests pass gate 5. A
founder debugging "no requests are getting through" will re-check DNS instead of finding F-B.

> **Fix pass 5 status: FIXED.** Item 4 now states plainly what it governs (outbound
> deliverability, not the inbound gate) and points at the real gate; a new item 4a covers the
> kill switch + `MAILGUN_AUTHSERV_ID` + spike-3 gate that actually decides whether inbound
> requests pass.

---

## Minor

> **Fix pass 5 status for this section:** the orchestrator scoped this fix pass to F-A, F-B,
> F-C, F-E, F-G, and the F-F/doc-sync items below — the Minor items here were not individually
> assigned. Two were fixed anyway as directly in the path of other work: the `.env.example`
> gap (below) is F-B's fix item 1, and the `fromDomain` `split('@')[1]` bug (below) was fixed
> alongside `request-pipeline.ts`'s other changes since it was trivial and exactly the shape of
> a regression the F-3 fix already existed to prevent. The remaining Minor items (the quarantine
> cap's silent suppression, `requester_address` on an unparseable `From`, the three
> `console.log` call sites, attachment memory buffering, and the per-file expiry-mode UI
> default) are **not addressed** in this pass — flagged here for a future pass, not silently
> dropped.

- **`.env.example` is missing six live config vars** (F-B). It is the file the runbook tells the
  operator to copy. Anything not in it does not exist operationally.
  > **Fix pass 5 status: FIXED** — see F-B's status note above.
- **`architecture.md §9`'s env list has drifted** from `config.ts` — `PG_SSL`, `RATE_DOMAIN_PER_HOUR`,
  `QUARANTINE_PER_TOKEN_PER_HOUR`, `WEBHOOK_BODY_LIMIT_BYTES`, `INBOUND_*`, `ZOHO_ACCOUNTS_BASE`,
  `ZOHO_LINK_ROLE_ID`, `GOOGLE_OAUTH_*` all arrived in fix passes; only README caught up.
- **README says "312 tests pass"; HEAD is 316 + 7 skipped.** Trivial in isolation, but a project
  whose credibility rests on precise counts should not have a stale one on its front page.
- **F-7's quarantine cap silently stops writing audit rows** past `QUARANTINE_PER_TOKEN_PER_HOUR`
  (`request-pipeline.ts:294`). Correct as DoS protection, but it means an attacker can cap the
  sender's visibility into an attack on their own file. Worth a single aggregate "N further
  attempts suppressed" row rather than pure silence.
- **Gate 6 writes `msg.recipientRaw` into `deliveries.requester_address`** when the `From` is
  unparseable (`request-pipeline.ts:145`), putting the file's own inbound address into the
  sender-facing "who received this" column. Harmless (it is their own token) but wrong data.
- **`fromDomain` at `request-pipeline.ts:68`** uses `split('@')[1]` for the stored
  `inbound_messages.from_domain` while every gate correctly uses `addressDomain()` (last `@`).
  Not security-relevant on this path — it is a display/audit column — but it is the exact shape
  of the F-3 bug and will read as a regression to the next reviewer. Use the same helper.
  > **Fix pass 5 status: FIXED** — `request-pipeline.ts` now calls `addressDomain()`.
- **`console.log` in `src/domain/files.ts:238`, `src/jobs/handlers/file-expire.ts:32`,
  `src/jobs/queue.ts:81`** routes around pino and its redaction list, which
  `run-and-deploy.md` item 8 explicitly warns against.
- **Attachment delivery buffers the whole file in memory** (`streamToBuffer`, up to
  `ATTACH_LIMIT_BYTES`). At `WORKER_CONCURRENCY=4` that is a 80 MB burst on a single stateful node
  with no documented memory floor. Worth a line in the runbook.
- **Per-file page: an existing expiry always renders as "custom date"**, never as the "30 days"
  radio (`http/routes/files.ts:131`), so the UX brief's default-state mock is never actually shown.

---

## What is genuinely strong — do not let the fix pass erode any of it

- **`SharingEngine` and its proof.** The two-phase reserve/external-call split, the advisory lock
  for the *decision* (not the rows), `intent_seq` unique + `appProperties` intent-key recovery as
  separate answers to mutual-exclusion vs idempotency, and a bounded retry loop with a documented
  deviation from the architecture's literal wording. `tests/integration/sharing-engine.test.ts`
  fires 50 concurrent `share()` calls on distinct connections against real Postgres and asserts
  copy-count, no-overshoot and contiguity. That is a real concurrency proof, not a mocked stand-in.
  It is the best code in the repository.
- **The honesty infrastructure.** `@unverified-live` markers → generated ledger → CI drift check →
  a runbook whose stated rule is *"don't flip a marker until you personally watched it complete."*
  "Zero live calls" appears in the README, the progress log, the ledger and the architecture brief,
  consistently. Most teams would have quietly written "integration complete."
- **`docs/runbooks/live-spikes.md`.** It anticipates the DC-host trap, warns that the contract
  suite passing does *not* prove the mapping is right, names the exact facts to record, and tells
  the operator to fix the code first and mark verified second. Genuinely excellent.
- **Tenant isolation.** Every repository method takes `tenantId` first and filters on it, exactly
  two documented cross-tenant resolvers, now enforced by four `no-restricted-imports` blocks that
  were verified to actually fire.
- **AC-R2.** Token-only resolution survived a sustained, imaginative attack — homoglyph domains,
  second `+file-` segments, attachment filenames carrying the victim's token, `deliver-to:` in the
  body. Nothing moved it.
- **The reviewer culture.** Red team, appsec, QA and code review each found real bugs, each pinned
  them as failing tests before the fix, and each fix note records what was *not* done and why. The
  `docs/lessons.md` loop is populated with the right lessons, in the right shape.

---

## What must be said to the founder plainly

1. **Nothing here has ever talked to Google, Zoho or Mailgun.** Zero live calls. The engineering
   is real; the integration is a well-documented hypothesis. Run the four spikes before you show
   this to a customer.
2. **The email-request half of the product — the whole email-only audience — may deliver nothing
   at all on day one.** Its gate depends on Mailgun reporting a DMARC verdict in a field nobody has
   seen. If that field is absent, every legitimate request is silently quarantined and neither you
   nor the requester is told. That is the *safe* failure. The unsafe one is F-B.
3. **"F-1 fixed" is overstated in the README, the ADR log, the progress log and the red-team fix
   status.** The gate is still forgeable in three of four realistic payload shapes, and the kill
   switch that was supposed to cover the gap defaults to ON and is not in `.env.example`.
4. **Expiry is a promise the default path cannot currently keep.** With the branded page off, the
   distribution link is Zoho's own URL; the only enforcement is a revoke call against an unverified
   endpoint, and if it fails the system can never recover — while telling you the file expired.
5. **Your architect dropped a control that `research/03` marks mandatory (the confirm-link), on a
   redundancy argument the red team has since undermined, and did not ask you.** That is a founder
   call. Make it explicitly, either way.
6. **Two decisions are load-bearing and reversible only expensively:** single stateful node with
   local-disk staging (fine at this scale, one adapter to change later — genuinely correct), and
   central accounts (correct; it deletes CASA and the blast radius). Both are well argued. The
   worker-in-process choice is the one to revisit first if a slow publish ever starves HTTP.
7. **Everything above is fixable in a focused pass.** Nothing found here calls the design into
   question.

---

## Per-AC verdict

| AC | Verdict | Caveat |
|---|---|---|
| **AC-U1** three artifacts | **MET** | Per-file page renders distribution link, mailto with the file's token, and editable settings the instant upload completes. Browser-verified by QA. |
| **AC-U2** flag OFF → raw Zoho link | **MET with caveat** | `Links.distributionUrl` is correct. But the value it returns comes from `createPublicLink`, which has never been called live; URL shape, `role_id` and embed token are spike-1 hypotheses. |
| **AC-U3** flag ON → branded page | **MET with caveat (serious)** | Proven against a fake whose `embedToken` is *deliberately* unrelated to the URL. The real adapter's fallback derives it from the raw link's last path segment, which would put the raw link's identifying token in the page HTML (F-E). Also unproven inside a real filter (spike 4). |
| **AC-U4** expiry enforced | **NOT MET** on the shipping default path | Request-time gates and the branded-page path are correct. On the flag-OFF path, revocation is the only enforcement, depends on an unverified endpoint, and is unrecoverable and unalarmed if it fails (F-C, reproduced). `drive.revoke` is never enqueued in that failure, so prior recipients keep access. |
| **AC-R1** DMARC-fail/absent → no delivery | **NOT MET** | Holds for every verdict the *provider* reports. The requester can still assert their own verdict whenever `message-headers` is absent, or when Mailgun stamps no `Authentication-Results` of its own (F-B, reproduced). |
| **AC-R2** file chosen only from the token | **MET** | The strongest-defended surface in the product. Body, subject, attachment filenames, `To:`, slug-only — all inert. |
| **AC-R3** delivery to the verified From only | **MET with caveat** | Structurally airtight: single-mailbox RFC 5322 parse, last-`@` domain, `Reply-To`/`Sender`/`Cc`/`Bcc`/`X-Original-From` all ignored. The word doing the work is "verified" — see AC-R1. |
| **AC-R4** ≤20 MB attach / larger Drive share | **MET with caveat** | Threshold branch proven at 19/21 MB against real streams. The "no Google account via email-OTP" half is a Workspace-only feature, unverified, and an open founder fork (PRD §10.4). Files 250 MB–1 GB route into invented code (F-G). |
| **AC-R5** custom message + display name | **MET** | Verbatim body, no boilerplate; display name safely encoded in subject and attachment filename; CR/LF injection tested. |
| **AC-R6** signature required | **MET** | Constant-time compare, ±300 s window, replay table, zero rows written on failure, body capped pre-parse. Extensively pinned. |
| **AC-E1** auto-duplicate at the cap | **MET with caveat** | 50-way concurrency proof is real — but the fake throws the *assumed* quota reason strings. If Drive's real `errors[].reason` differs, `QuotaClass` never matches, auto-duplication never fires, and requests fail with the raw quota error this AC exists to prevent. Spike 2 is the single highest-value fact in the runbook. |
| **AC-E2** idempotent, serialized per (tenant, file) | **MET** | Real Postgres, distinct connections, crash-injected mid-provision, copy-count and contiguity asserted. No caveat. |
| **AC-A1** file-scoped access only | **MET** | One permission on one Drive file per delivery; per-file Zoho links; no folder or account grant is ever requested of the port. |
| **AC-A2** every delivery audit-logged | **MET with caveat (serious)** | The log exists, is queryable and updates live. Two holes: F-A writes `sent` for deliveries that never happened, and F-7's quarantine cap stops writing rows past 5 per token per hour. A trust mechanism that can be wrong in the optimistic direction is worse than one that is merely incomplete. |
| **AC-A3** tenant isolation | **MET** | Airtight across every read and write path; the one false-success delete route QA found is fixed; now lint-enforced. |

---

## Lessons filed

Three entries appended to `docs/lessons.md` (CLAUDE.md §7): the conditional-fix trap, the
fake-that-proves-the-assertion trap, and the safe-default-of-a-kill-switch rule.

## Re-check protocol

I will re-attack after the fix pass, focusing on: (1) does the outbound failure classification
distinguish definite from ambiguous, or just move the guess; (2) does `message-headers`-absent now
fail closed end to end, at the pipeline and not only in the mapper; (3) can a permanently failing
`revokeLink` still strand a file silently; (4) does the branded page still render when the embed
token was derived rather than reported. Each of the three reproductions above should exist as a
committed regression test before this gate is called passed.

---
---

# Re-check verdict — 2026-09-08 (after fix pass 5)

**Owner:** critic · **Branch:** `claude/swenlly-system-2-file-sharing-32nrdu` ·
**HEAD:** `9a46281` · **Method:** ran the re-check protocol above against the *code*, not the
fix-status notes. `pnpm test` at HEAD: **340 passed, 7 skipped, 60 files, zero failures.**
Wrote four throwaway probe suites (all deleted; nothing in `src/**` touched, nothing committed).

## Verdict: **FIX-FIRST**

Four of the five ship-blocking/serious findings are genuinely, verifiably closed — I re-ran my
own reproductions and they no longer reproduce. **F-B is not closed.** The fix narrowed the
attack surface substantially and, critically, closed the *exposure window* by defaulting the
kill switch off — but the gate itself is still forgeable, and I now have a bypass that works
**unconditionally**, including in the case where Mailgun does everything right. It is
documented as closed in the README, the runbook, ADR 11 and the red-team report.

This is a smaller FIX-FIRST than the last one. Nothing here touches the design. One module
(`src/adapters/mailgun/mapping.ts` source (b)) and the four documents that describe it.

---

## Per-finding status

### F-A · outbound failure classification — **CLOSED**

My original reproduction no longer reproduces. Re-ran it verbatim:

```
before (fix pass 4):  attempt 1 = dispatching · attempt 2 = sent (ack_lost) · mails sent = 0
now   (fix pass 5):   attempt 1 = sending    · attempt 2 = sent            · mails sent = 1
```

The classification is real, not a moved guess. `AmbiguousSendError extends PortError` (not
`TransientError`), so `isDefiniteNonSend` cannot accidentally swallow it. Four scenarios,
verified at the handler level:

| failure | outcome | mail actually sent | retried |
|---|---|---|---|
| transient (completed 5xx/429) | `sending` → retry → `sent` | 1 | yes |
| permanent (completed 4xx) | `failed` (dead-letter hook) | 0 | yes, then dead-lettered |
| ambiguous (no response) | `unconfirmed` — never `sent` | 0 | no, by design |
| crash between grant and reply | stays `granted`, reply-only retry; `share_count` stays 1 | 1 | reply only, never re-shares |

The Drive-share `granted` CAS step is the right shape and the `share_count === 1` assertion is
the correct proof that it never re-shares.

**Two residuals, both minor, both new — flagged, not blocking:**

1. **A bare process crash mid-`dispatching` permanently abandons the delivery.** Probed:
   `outcome = unconfirmed`, `reason = crash_no_definite_error`, job `done`, zero retries,
   zero mails. That is *honest* (the whole point of the finding) but it is a dead end: on a
   single stateful node, an ordinary deploy restart during a delivery silently drops it.
   `unconfirmed` renders as a pill ("לא מאומת") and is counted nowhere — there is no
   `/readyz` counter and no resend action anywhere in `src/http/routes/`. The pattern from
   F-C's fix (record it, count it in `/readyz`, badge it) is exactly what this needs.
2. **`src/adapters/mailgun/real.ts:159-171` misclassifies one case.** A 2xx response whose
   body read fails (`res.text().catch(() => '')` swallows it) or whose JSON carries no `id`
   throws `PermanentError` — i.e. "definite non-send" — for an exchange in which Mailgun
   **accepted the message**. It is the same "guess in the confident direction" the finding
   was about, pointed the other way. Cheap fix: `AmbiguousSendError` when the status was 2xx
   but the body could not be read.

Honest note on the idempotency key: `v:swenlly-delivery` and `h:Message-Id` do **not** make
Mailgun deduplicate — Mailgun has no such feature on these fields. The fix note says
"traceable", not "deduped", which is correct; the `errors.ts` doc comment saying a
`PermanentError` "dead-letters rather than burning through `JOB_MAX_ATTEMPTS`" is not what
`processNextJob` does (it burns the full budget for every error class). Doc, not code.

---

### F-B · the DMARC gate — **NOT CLOSED.** Reproduced, twice, at the pipeline level

The four "Do this" items were all implemented and three of them are genuine improvements:
`message-headers`-absent now fails closed **end to end** (my payloads A and B are dead at the
pipeline, not just the mapper); the unvalidated top-level fallback is gone; the priority is
flipped; `INBOUND_REQUESTS_ENABLED` defaults `false` with a cross-field production check, a
drift-detecting `.env.example` test, and a runbook item. That is real work and it closes the
*window*.

**But the fix rests on a false premise: that `MAILGUN_AUTHSERV_ID` is a secret.** The test
file says "a genuine, **non-public** value"; the runbook says "never `INBOUND_DOMAIN` — that
value is public and guessable"; the README says the same. An RFC 8601 authserv-id is the
*receiving MTA's hostname*. For Mailgun it is `mxa.mailgun.org` / `mxb.mailgun.org` — the
value published in the MX record for `INBOUND_DOMAIN`, one `dig` away, and the same for every
Mailgun customer on earth. It is not a secret and cannot be made one.

Test C in `tests/review/dmarc-gate-payloads-a-d.test.ts` and its mapper twin therefore attack
the wrong string: they forge an `Authentication-Results` naming the **old** `INBOUND_DOMAIN`
fallback value and assert it is rejected. Of course it is. The attack is to name the
**configured** value.

**Reproduction C′** (throwaway pipeline test, since deleted). `message-headers` present,
Mailgun stamps no `Authentication-Results` of its own (exactly the unknown spike 3 exists to
settle), attacker's own MIME header:

```
Authentication-Results: mxa.mailgun.test; dmarc=pass header.from=target.test
From: victim@target.test
→ {"deliveryId":"PRESENT","outcome":"queued","requester":"victim@target.test"}
```

**Reproduction C″** — the authserv-id check is a DNS-suffix match
(`mapping.ts:130-133`, `candidate.endsWith('.' + configured)`), pinned as intended behaviour
at `tests/unit/mailgun-mapping.test.ts:66`. `evil.mxa.mailgun.test` is accepted:

```
→ {"deliveryId":"PRESENT","outcome":"queued"}
```

README and runbook both say the authserv-id must match "**exactly**". The code does not.

**Reproduction F — the one that matters, because it holds even when Mailgun behaves
perfectly.** Source (a)'s anti-forgery guard discards a synthetic field whenever
`knownHeaderNames` contains the same key. The attacker controls `knownHeaderNames` — it is
the list of their own MIME headers. So the attacker can *choose which source answers*: add a
header literally named `Dmarc:` to knock Mailgun's genuine verdict out, then serve their own
via source (b).

```
payload.dmarc = 'fail'            <-- Mailgun's OWN genuine verdict on the forged message
message-headers:
  ['Dmarc', 'whatever']           <-- attacker's header; kills source (a) wholesale
  ['Dmarc-Domain', 'whatever']
  ['Authentication-Results', 'mxa.mailgun.test; dmarc=pass header.from=target.test']

→ PROBE-F {"deliveryId":"PRESENT","outcome":"queued","requester":"victim@target.test"}
   control, same payload without the two attacker headers:
→ PROBE-G {"deliveryId":"absent","outcome":"quarantined","reason":"dmarc_fail"}
```

The control proves the defense works only while the attacker declines to use it. The dedup
guard's logic is inverted: a collision means *this verdict cannot be trusted*, and the honest
response is `unknown` for the whole extraction — not a silent fall-through to the weaker
source the attacker prefers.

**Impact, unchanged from the original finding and still not inflated.** Not a direct
exfiltration primitive (AC-R3 still binds delivery to the parsed `From`). The harm is
outbound abuse: anyone holding a mailto link can make Swenlly email a customer's file, up to
250 MB, from Swenlly's sending domain, to an address of their choosing, bounded only by
`RATE_TENANT_PER_HOUR`. For a company whose thesis is "email is the transport that survives
the filter," that is close to existential. Plus: the allowlist stays bypassable, and
`deliveries.dmarc = 'pass'` remains a requester assertion rather than a fact.

**Severity now: fatal-on-flip rather than fatal-today.** `INBOUND_REQUESTS_ENABLED=false` is
the default and production refuses to boot with it true and no authserv-id. Nothing is exposed
until the founder flips it. But spike 3's brief is "confirm the field name," and both the
runbook and the README will tell the operator that confirming the field name is what makes it
safe to flip. It is not.

**Do this (smaller than last time):**
1. **A `message-headers` entry whose name collides with a Mailgun synthetic field name makes
   the whole extraction `unknown`** — never a fall-through to source (b). One branch in
   `extractAuthResult`. This alone kills reproduction F.
2. **Decide, don't hedge.** `INBOUND_AUTH_SOURCE=both` is what makes reproduction F possible
   at all. Spike 3 will tell you which source Mailgun actually populates; default to
   `mailgun-fields` (the only source with any anti-forgery property at all) and make `both`
   an explicit, documented degradation.
3. **Drop the DNS-suffix match** or document it accurately. It widens an already-public
   string. If real-world values are `mxa.<host>`, configure `mxa.<host>`.
4. **Rewrite tests C (both copies) to forge the configured authserv-id, not the old
   fallback**, and add reproduction F as a pinned test. The current tests prove that a
   *badly configured* deployment is protected, which is not the claim being made.
5. **Correct the four documents again** — this time to: *"the inbound DMARC verdict is not
   forgery-proof; it is held shut by `INBOUND_REQUESTS_ENABLED=false` and must not be flipped
   until source (b) is either removed or given a discriminator Mailgun actually provides."*

---

### F-C · silent expiry stranding — **CLOSED**

My reproduction no longer reproduces. Re-ran it further than the committed regression test
does — six full sweep windows with `revokeLink` throwing `PermanentError` every time:

```
round 0..5: status=expired · expiry_error=set · /readyz.strandedExpiries=1 · job=dead
            revokeAttempts = 2,4,6,8,10,12   <-- it keeps retrying, every window, forever
after the underlying failure is fixed:
            status=expired · expiry_error=null · strandedExpiries=0   <-- self-heals
```

All three items done, and done well. The ordering change — flip `status` and enqueue every
`drive.revoke` **first**, unconditionally, then let the unverified Zoho call throw — is the
right architectural instinct: it makes the parts that *can* be guaranteed independent of the
part that cannot. The steady state is a job that flaps `dead → pending → dead` once per sweep
window while staying visibly counted, which is exactly right. The residual is inherent, not a
defect: on the flag-OFF path the raw Zoho link genuinely stays live while `revokeLink` fails.
The system now says so out loud instead of lying.

### F-D · the confirm step — **CLOSED as governance, open as a fork (correct)**

The governance half is what I asked for and it is done: ADR 6 carries an amendment, README's
open-questions section carries the decision with both options and the reasoning, and the
orchestrator raised it rather than resolving it by omission. The added reasoning — a
click-to-confirm link is unopenable by this product's audiences, so reply-to-confirm is the
only buildable variant — is a genuinely better framing than mine was; I named the control,
not the form it would have to take here.

The engineering half stays open, and F-B's non-closure sharpens it: reply-to-confirm is the
one control that does not depend on Mailgun's field naming at all. If the founder wants the
inbound path live before spike 3 resolves cleanly, this is the way.

### F-E · derived embed token — **CLOSED**

`extractEmbedToken` has no derive path; it returns `null` when no `embed_url`/`embed_link` is
present. `FileStorePort.createPublicLink` types it `string | null`. `GET /s/:slug` renders the
page without an iframe rather than falling back
(`src/http/routes/public-share.ts:31-40`). The regression test forces the null path through a
real publish and asserts no ≥12-character substring of the raw link's path appears in body or
headers — stronger than the whole-string check I asked for. Spike 1's headline output is now
the right question. Nothing left here.

### F-F · four documents overstate F-1 — **PARTIALLY CLOSED; the residual is F-B's**

The *form* is fixed and the fix is good: all four now state a property with its precondition
rather than describing the change. The problem is that the property they state is still not
true. README: *"never the flat namespace attacker-controlled MIME headers also occupy"* —
source (b) reads `message-headers`, which is precisely the array of attacker-controlled MIME
headers; the only discriminator is a public hostname. README and runbook: *"matches
`MAILGUN_AUTHSERV_ID` **exactly**"* — the code also accepts any DNS suffix (C″). Runbook 4a:
"never set it to `INBOUND_DOMAIN`… that value is public" — implies the correct value is not.

The instruction was "then make that sentence true." The sentence was written; F-B did not make
it true. Closes when F-B does.

### F-G · `MAX_UPLOAD_BYTES` — **CLOSED, and improved on**

Default is 262,144,000. Beyond what I asked: `ZohoFileStore.upload` throws a `PermanentError`
with no request attempted unless `ZOHO_LARGE_UPLOAD_ENABLED=true` (default `false`), so a
stale `MAX_UPLOAD_BYTES` can no longer route a real file into invented code. That is the right
generalisation of the finding — defend the invariant at the boundary that owns it, not only at
the config that happens to gate it today.

### F-H · runbook item 4 — **CLOSED**

Item 4 now states plainly that it governs outbound deliverability and has no effect on the
inbound gate, keeps the correction visible rather than editing history, and points at the new
item 4a. Item 4a is the checklist entry the product needed.

### Minor items — as reported

`.env.example` gap and the `fromDomain` `split('@')[1]` bug are fixed (verified:
`request-pipeline.ts:73` uses `addressDomain()`). README's test count is current (340). The
five deferred items are still open and were honestly declared as deferred, which is the
correct handling. `console.log` survives at `src/jobs/handlers/file-expire.ts:48` and
`src/jobs/queue.ts:81`.

---

## New findings from this pass

- **N-1 (serious).** The dedup guard in `extractFromMailgunFields` is attacker-triggerable and
  fails *open* into the weaker source rather than closed. Reproduction F above. This is the
  same lesson as `docs/lessons.md`'s "a guard whose input is optional must fail closed,"
  one level up: *a guard whose input the attacker can poison must fail closed too.*
- **N-2 (serious).** `unconfirmed` is a terminal dead end with no counter, no alarm and no
  resend affordance — a routine deploy restart mid-delivery silently drops a file delivery.
  F-C's fix has the pattern to copy.
- **N-3 (minor).** `src/adapters/mailgun/real.ts` classifies a 2xx-with-unreadable-body as
  `PermanentError` (definite non-send) for an exchange Mailgun accepted.
- **N-4 (minor).** The authserv-id DNS-suffix match is undocumented in the two places that
  describe it as exact, and pinned as intended at `mailgun-mapping.test.ts:66`.

## Updated per-AC verdict

| AC | Previous | Now | Note |
|---|---|---|---|
| **AC-U1** three artifacts | MET | **MET** | unchanged |
| **AC-U2** flag OFF → raw Zoho link | MET w/ caveat | **MET with caveat** | unchanged: spike-1 hypotheses |
| **AC-U3** flag ON → branded page | MET w/ caveat (serious) | **MET with caveat (minor)** | F-E closed; the derive path is gone and the null case refuses to render. Residual is spike 4 only. |
| **AC-U4** expiry enforced | **NOT MET** | **MET with caveat** | F-C closed and re-proved over six sweep windows. Caveat is inherent, not a defect: on the flag-OFF path the raw link stays live while an unverified `revokeLink` fails — now expired in-product, retried every window, counted in `/readyz`, badged. |
| **AC-R1** DMARC-fail/absent → no delivery | **NOT MET** | **NOT MET** | Improved (A, B dead end to end; window closed by default) but reproductions C′, C″ and F stand. F is unconditional. |
| **AC-R2** file chosen only from the token | MET | **MET** | unchanged; still the strongest surface here |
| **AC-R3** delivery to the verified From only | MET w/ caveat | **MET with caveat** | structurally airtight; "verified" still inherits AC-R1 |
| **AC-R4** ≤20 MB attach / larger Drive share | MET w/ caveat | **MET with caveat (reduced)** | F-G closed: nothing routes into invented code without an explicit opt-in. Google account-type fork still open (PRD §10.4). |
| **AC-R5** custom message + display name | MET | **MET** | unchanged |
| **AC-R6** signature required | MET | **MET** | unchanged |
| **AC-E1** auto-duplicate at the cap | MET w/ caveat | **MET with caveat** | unchanged; spike 2 is still the highest-value fact |
| **AC-E2** idempotent, serialized per (tenant, file) | MET | **MET** | unchanged; still the best code here |
| **AC-A1** file-scoped access only | MET | **MET** | unchanged |
| **AC-A2** every delivery audit-logged | MET w/ caveat (serious) | **MET with caveat (minor)** | F-A closed: the log no longer claims `sent` for a delivery that did not happen, and `unconfirmed` is an honest third state. Remaining holes are the quarantine cap (deferred minor) and N-2. |
| **AC-A3** tenant isolation | MET | **MET** | unchanged |

## What is still genuinely strong

Everything in the original list survived the fix pass intact — I re-checked the
`SharingEngine` proof, the `@unverified-live` ledger and the tenant-isolation lint blocks, and
none of them were eroded. Add to it: **the F-C fix is the best work in this pass** — flipping
the guaranteed-local work ahead of the unverifiable external call, then making the failure
counted, badged, retried and self-healing, is a pattern worth reusing everywhere this codebase
calls a provider it has never talked to. And the `docs/lessons.md` entry recording a race the
fix pass introduced *and caught itself* is the loop working as designed.

## What must be said to the founder plainly

The last report said five things. Four of them are now fixed and I checked each by re-running
my own break-it tests rather than reading the notes: a flaky mail provider no longer loses a
file while telling you it was delivered; expiry can no longer fail silently — it now expires
the file immediately, keeps retrying the revoke every fifteen minutes forever, shows you a
badge, and heals itself when the underlying problem is fixed; the branded page can no longer
leak the raw Zoho link; and large files no longer get routed into unverified code. The
confirm-step question is now properly on your desk as a decision instead of being quietly
resolved by an architect, and the reframing is better than mine was.

One is not fixed, and it is the same one as last time. The email-request gate — the thing that
decides "is this person really who they say they are" — is still forgeable. The fix assumed
that a certain configuration value is a secret. It isn't: it's the name of Mailgun's mail
server, published in your own DNS, identical for every Mailgun customer. I also found a
sharper version of the attack that works even if Mailgun does everything correctly: the
attacker adds one junk header to their own email, which switches off the good check, and then
supplies their own answer through the weaker one. I reproduced both. The good news, and it's
real: the switch that turns this whole path on now defaults to **off**, and the server refuses
to start in production if you turn it on without the required configuration. So nothing is
exposed today. The danger is the instruction sheet — the runbook and the README will tell you
that once the live spike confirms a field name, it's safe to flip on. It is not. Do not flip
`INBOUND_REQUESTS_ENABLED=true` until either the weaker source is removed, or you've decided
to add the reply-to-confirm step (the F-D fork) — which happens to be the one control that
doesn't depend on any of this.

Two smaller things worth a sentence. If the server restarts in the middle of sending a file,
that one delivery is now honestly marked "unverified" instead of falsely marked "sent" — which
is the right fix — but it is then abandoned, with nothing to alert you and no way to resend.
And the "how many tests pass" number, the ledger of what's been verified against real
providers, and the honesty of the fix notes all held up under a second adversarial read. Zero
live calls still means zero live calls.

## Re-check protocol (next pass)

Short. Re-run reproductions C′, C″ and F at the pipeline level; confirm a Mailgun-synthetic-
field-name collision in `message-headers` yields `unknown` for the *whole* extraction; confirm
the two rewritten C tests forge the *configured* authserv-id; confirm the four documents state
the gate's real, current guarantee. Then this is SHIP-READY-FOR-LIVE-SPIKES.


---

## Fix pass 6 status (orchestrator, 2026-09-08) — response to the re-check

**F-B (not closed at re-check) → fixed in `src/adapters/mailgun/mapping.ts`, tests at both levels.**
The property now: the verdict comes from exactly ONE operator-chosen source
(`INBOUND_AUTH_SOURCE=mailgun-fields` default, or `authentication-results`); `both` and every
fallback between sources are gone (N-1). Each source is classified absent / ambiguous / present
before use: a synthetic-field name that also appears in `message-headers` makes the synthetic
source ambiguous; more than one `Authentication-Results` naming our authserv-id (any order, so
no dependence on prepend) makes the header source ambiguous; the authserv-id matches by exact
equality only (C″). Ambiguity in either source, or a DMARC disagreement between them, yields
`unknown`. A forged header can therefore only ever downgrade a verdict.
- C′ (forged single A-R naming the real authserv-id): quarantined `dmarc_unknown` in
  `mailgun-fields` mode (`tests/review/dmarc-gate-payloads-a-d.test.ts`, mapper test in
  `tests/unit/mailgun-mapping.test.ts`). In `authentication-results` mode it remains the stated
  residual — indistinguishable from a genuine stamp when Mailgun stamps none — so that mode is
  gated on spike 3c (`docs/runbooks/live-spikes.md`: send a request that already carries a forged
  entry; two entries ⇒ Mailgun stamps on every message ⇒ mode permitted).
- C″ (DNS-suffix authserv-id): `dmarc_unknown`, both levels.
- F (attacker adds a `Dmarc:` MIME header): `dmarc_unknown` in both modes — the collision no
  longer falls through to another source.
- D now yields `dmarc_unknown` rather than `dmarc_fail` (two entries naming ours ⇒ ambiguous);
  still a quarantine, strictly stricter, and order-independent.
- The runbook (`run-and-deploy.md` 4a) now says the authserv-id is public, that ONE mode must be
  chosen from what spike 3 shows, and that neither signal ⇒ keep the path closed. The four
  documents state the property with its precondition.

**N-1** — closed by the same change (no fallthrough exists).
**N-2** — `unconfirmed` deliveries are counted in `/readyz` (`unconfirmedDeliveries`) and logged
at `warn`; the row is visible in the sender's deliveries table as "לא מאומת". A one-click resend
is not built (the requester can simply send the request again; each request is a new delivery).
**N-3 / N-4** — not addressed in this pass; carried in the Minor list.

Suite after fix pass 6: 348 passed, 7 live-gated skips, zero `it.fails`.

---

## Second re-check verdict (critic, 2026-09-08) — after fix pass 6

**Method.** I did not read the fix-pass-6 status note as evidence. I re-ran C′, C″ and F at the
pipeline level in **both** `INBOUND_AUTH_SOURCE` modes, plus nine new mapper probes and seven new
pipeline probes of my own, against HEAD (`ad689c2`). Full suite re-run: **348 passed, 7 skipped,
60 files, zero failures.** All probes deleted; `src/**` untouched; nothing committed.

### Verdict: **FIX-FIRST** — but a far narrower one than the last two passes

Concretely: **the live spikes can start today.** Spikes 1, 2, 3a, 3b, 4 and the *capture* half of
3c expose nothing — `INBOUND_REQUESTS_ENABLED=false` is the default and production refuses to boot
otherwise. What must be fixed first is the *decision* the spikes feed: two new fail-opens in
`INBOUND_AUTH_SOURCE=authentication-results` (≈3 lines of code between them), and two of the four
documents that still describe a design fix pass 6 deleted.

---

### F-B — **CLOSED in the default mode. NOT closed in `authentication-results` mode.**

`src/adapters/mailgun/mapping.ts` is materially better work than the last two attempts. Verified
against the code, not the note:

- **No fallback path exists.** `combine()` (`:210-217`) returns `EMPTY_AUTH` the moment the
  authoritative source is not `present`. There is no second door. N-1 is genuinely closed.
- **Exact-match is the only authserv-id rule.** `authservIdMatches` (`:131-133`) is a single
  `===` after trim+lowercase. The `endsWith` suffix rule is gone, and the test that *pinned* it
  as intended behaviour (`tests/unit/mailgun-mapping.test.ts:66`) now asserts the opposite. N-4
  closed.
- **A synthetic-field-name collision yields `unknown` for the whole extraction**, not just for
  `dmarc`. Confirmed with a collision on a *non-dmarc* name, which is the stricter test:

```
payload: dmarc=pass spf=pass dkim=pass dmarc-domain=evil.test
message-headers: [['From',…],['Spf','whatever']]        <-- collides on `spf`, not `dmarc`
→ {"dmarc":"unknown","spf":null,"dkim":null,"dmarcDomain":null}
same with ['Dmarc-Domain','w']                          → identical
```

- **The rewritten tests forge the configured authserv-id.** C′, C″ and F in
  `tests/review/dmarc-gate-payloads-a-d.test.ts` all use `container.config.MAILGUN_AUTHSERV_ID`.
  (Legacy A–D keep the old `INBOUND_DOMAIN` string, which is correct — they are the *old* probes,
  retained as history, and C′ is the replacement.)

**Pipeline results, both modes, my own probes:**

| probe | `mailgun-fields` (default) | `authentication-results` |
|---|---|---|
| C′ forged single A-R, configured id | quarantined `dmarc_unknown` | **queued** — declared residual |
| C″ `evil.<id>` DNS suffix | quarantined `dmarc_unknown` | quarantined `dmarc_unknown` |
| F attacker adds `Dmarc:` MIME header | quarantined `dmarc_unknown` | quarantined `dmarc_unknown` |
| **N-5** genuine stamp `<id> 1;` + forged clean | quarantined `dmarc_unknown` | **queued, `dmarc=pass`** |
| **N-5b** genuine stamp `<id> (Mailgun);` + forged | quarantined `dmarc_unknown` | **queued, `dmarc=pass`** |
| **N-6** genuine `dmarc-domain` ≠ forged `header.from` | quarantined `dmarc_domain_mismatch` | **queued, `dmarc=pass`** |
| control, fully genuine | queued (correct) | queued (correct) |

In the **default configuration this gate is now sound against every payload shape I could
construct.** That is a real close and it took three passes to get here.

---

### New — **N-5 (serious; fatal-on-flip).** The authserv-id parser is not RFC 8601, and it breaks the one property spike 3c can prove

`parseAuthenticationResultsValue` (`:105-127`) takes everything before the first `;` as the
authserv-id. RFC 8601's grammar is `authserv-id [ CFWS authres-version ]` — a legal genuine
header may be `mxa.mailgun.org 1; dmarc=fail …` or `mxa.mailgun.org (Mailgun Inc); dmarc=fail …`.
Both parse to an authserv-id that does not `===` the configured value, so **Mailgun's genuine
verdict is silently discarded and the attacker's clean forgery becomes the unique match**:

```
message-headers:
  ['Authentication-Results', 'mxa.mailgun.test 1; dmarc=fail header.from=evil.test']  <-- genuine
  ['Authentication-Results', 'mxa.mailgun.test; dmarc=pass header.from=evil.test']    <-- forged
→ PIPE [authentication-results] {"deliveryId":"PRESENT","outcome":"queued","dmarc":"pass"}
   (comment form gives the identical result)
```

This is not the documented residual. The mapper doc comment (`:45-52`) says the residual is
"Mailgun does NOT stamp its own header." Here Mailgun **does** stamp, **does** say `dmarc=fail`,
and the forgery still wins. Worse, it invalidates the safety argument the doc comment and the
runbook both rest on: *"including one that already carries a forged copy (then there are two, and
rule 3 quarantines)."* There are two in the payload; the code counts one.

Spike 3c's pass criterion is written as a single sentence — *"`message-headers` shows TWO entries
naming the authserv-id **and** the pipeline quarantines"* — which an operator will read as an
observation with a consequence, not as two independent checks. If Mailgun's real stamp carries a
version or a comment, the operator sees two entries, ticks the box, and enables a forgeable mode.

**Do this:** (1) parse the authserv-id per RFC 8601 — strip a trailing version token and any
CFWS comment before comparing; (2) make spike 3c's pass criterion the **pipeline outcome**, as a
standalone hard stop ("if the request was delivered rather than quarantined, STOP — do not enable
this mode"); (3) pin N-5's two payloads as regression tests.

### New — **N-6 (serious; same mode).** `combine` cross-checks the verdict but never the evaluated domain

`combine` (`:213`) compares `other.auth.dmarc !== authoritative.auth.dmarc` only. `dmarcDomain` —
the value gate 6 uses as the anti-spoofing binding — is taken from the authoritative source
verbatim and never compared against the other source, even when the other source has it:

```
payload: dmarc=pass  dmarc-domain=good.test          <-- Mailgun's genuine evaluated domain
message-headers: ['Authentication-Results', '<id>; dmarc=pass header.from=evil.test']
→ [authentication-results] queued, dmarc=pass, aligned against evil.test
→ [mailgun-fields]         quarantined `dmarc_domain_mismatch`   <-- correct behaviour, one mode away
```

The `mailgun-fields` column shows the system already knows how to catch this. The fix is one line
of symmetry: treat a `dmarcDomain` disagreement exactly as a `dmarc` disagreement. That also
narrows N-5 — with the domain cross-checked, N-5's attack fails whenever Mailgun populates its
synthetic fields at all.

### New — **N-7 (serious, documentation).** Two of the four documents still describe the design fix pass 6 deleted

The re-check item was "confirm the four documents state the gate's real current guarantee."
**Two of four do; two do not**, and it is the same two as last pass.

- `README.md:113-120` — *"DMARC/SPF/DKIM come from Mailgun's own synthetic fields **or** a
  `message-headers` `Authentication-Results` entry"*. That `or` is precisely the two-source model
  fix pass 6 removed. Cites "(fix pass 5, F-B)" as current. No mention of `INBOUND_AUTH_SOURCE`
  in the security-model section, and **no mention of the residual at all**. `README.md:18` still
  claims "340 tests pass" (348).
- `docs/decisions.md` ADR 11 — `grep -c 'fix pass 6\|INBOUND_AUTH_SOURCE' docs/decisions.md` is
  **0**. ADR 11 ends at the fix-pass-5 correction and still states the `or` model. There is no ADR
  anywhere recording what is genuinely the most consequential architectural decision of this pass:
  *one operator-chosen source, no fallback, ambiguity fails closed.* That decision exists only in
  a code comment and a critic report.
- `docs/progress.md:34-36` — accurate and current. ✅
- `docs/security/red-team-report.md` §6 F-1 — accurate, current, **and states the residual
  explicitly.** The best of the four. ✅

`docs/runbooks/run-and-deploy.md` item 4a is also good and honest: it says outright that the
authserv-id is Mailgun's PUBLIC hostname, that exactly one mode must be chosen from what spike 3
shows, and that neither signal means keep the path closed. That is the correction I asked for.

**Would the runbook stop an operator from flipping the switch unsafely?** For `mailgun-fields`:
yes. For `authentication-results`: **no** — because of N-5 its central test can pass while the
gate is open, and because of N-7 the two documents an operator is most likely to read first still
describe a gate that no longer exists.

### N-8 (minor) — stale text inside the safety documents themselves

- `docs/runbooks/live-spikes.md:204-206`: *"leave unset to exercise the `INBOUND_DOMAIN` fallback
  default"* — that fallback was deleted (it is now `mailgun.org`), and the same file contradicts
  itself 60 lines later with *"required, never defaulted — `container.ts` no longer falls back to
  `INBOUND_DOMAIN`."*
- Same file, spike 3b: *"the F-1 kill switch, **default true**"* — it defaults `false`.
- `src/config.ts:153-155`: *"`container.ts` falls back to `INBOUND_DOMAIN` when this is unset"* —
  it no longer does (`container.ts:190`).
- `.env.example:70-73` and `config.ts:206` still frame the authserv-id as needing to be
  non-public. Runbook 4a corrected this premise; these two did not get the memo.
- `docs/runbooks/run-and-deploy.md:96-97` describes `/readyz` as `{ok, db, pendingJobs}` — it now
  also returns `sweeps`, `strandedExpiries`, `unconfirmedDeliveries`.
- `tests/setup/container.ts:69` retains `?? config.INBOUND_DOMAIN`, the fallback production
  deleted. Harmless today (the test config always sets it), but it is the deleted bug living on
  in the harness.

### N-1 — **CLOSED.** N-2 — **CLOSED as far as it goes (downgraded to minor)**

N-1: verified structurally, not by note — `combine` has no fall-through and neither source is
consulted when the other is authoritative and absent.

N-2: `/readyz` now returns `unconfirmedDeliveries` and logs at `warn` when non-zero
(`src/http/routes/health.ts:22-25`); the row renders as "לא מאומת" with the red quarantine pill
(`src/lib/presentation.ts:64`). `ok` correctly stays `true` — this is an operator signal, not a
readiness failure. No resend action was built; the stated rationale (the requester simply asks
again, and each request is a new delivery) holds on this product's only delivery path. Accepted
as minor. Honest declaration, real surface, proportionate scope.

### N-3 (minor) — still open, honestly carried: a 2xx exchange with an unreadable body is classified `PermanentError`.

---

### Final per-AC verdict

| AC | Last pass | Now | Note |
|---|---|---|---|
| **AC-U1** three artifacts | MET | **MET** | unchanged |
| **AC-U2** flag OFF → raw Zoho link | MET w/ caveat | **MET with caveat** | unchanged; spike-1 hypotheses |
| **AC-U3** flag ON → branded page | MET w/ caveat (minor) | **MET with caveat (minor)** | unchanged; residual is spike 4 |
| **AC-U4** expiry enforced | MET w/ caveat | **MET with caveat** | unchanged; F-C stayed closed under re-probe |
| **AC-R1** DMARC-fail/absent → no delivery | **NOT MET** | **MET in the default config; NOT MET under `INBOUND_AUTH_SOURCE=authentication-results`** | C′/C″/F/N-5/N-6 all quarantine in `mailgun-fields`. The alternative mode fails C′ (declared), N-5 and N-6 (not declared). Requires an explicit operator flip; kill switch defaults off. |
| **AC-R2** file chosen only from the token | MET | **MET** | unchanged; still the strongest surface |
| **AC-R3** delivery to the verified From only | MET w/ caveat | **MET with caveat** | structurally airtight; "verified" inherits AC-R1, incl. N-6's domain gap |
| **AC-R4** ≤20 MB attach / larger Drive share | MET w/ caveat | **MET with caveat** | unchanged; Google account-type fork open |
| **AC-R5** custom message + display name | MET | **MET** | unchanged |
| **AC-R6** signature required | MET | **MET** | unchanged |
| **AC-E1** auto-duplicate at the cap | MET w/ caveat | **MET with caveat** | unchanged; spike 2 |
| **AC-E2** idempotent, serialized per (tenant, file) | MET | **MET** | unchanged; still the best code here |
| **AC-A1** file-scoped access only | MET | **MET** | unchanged |
| **AC-A2** every delivery audit-logged | MET w/ caveat (minor) | **MET with caveat (minor)** | N-2 now counted, logged and badged; no resend action |
| **AC-A3** tenant isolation | MET | **MET** | unchanged |

### What is genuinely good in this pass

The mapper rewrite is the right shape and I could not break it in the default mode. Three things
in particular: classifying each source as **absent / ambiguous / present** *before* using it —
that vocabulary is what made the collision bug expressible at all; deleting `both` rather than
hardening it, which removed the attacker's ability to choose the door; and making the collision
rule poison the **whole** extraction rather than the one colliding field, which I checked with a
non-`dmarc` collision specifically because that is where a partial fix would have shown. Spike 3c
is a better test than the one I asked for — it tells the operator to send a *pre-forged* message,
which is real adversarial thinking applied to a runbook. And `red-team-report.md` §6 F-1 is the
model the other three documents should copy: it states the property, its precondition, **and the
residual**, in that order.

### Plain language, for the founder

The email gate is now genuinely closed in the setting the product ships with. I attacked it
sixteen different ways this time, including the two attacks that beat it last round, and in the
default setting every single one was blocked and the honest message still got through. That is
real progress and it is the first time I can say it.

There is a second, optional setting the code offers, and it is the one I would not let you turn
on. It trusts a stamp that the receiving mail server writes onto the message. The problem is that
the code recognises that stamp only when it is written in one exact spelling — and the official
standard permits two other perfectly normal spellings. If Mailgun uses either of them, the code
throws away Mailgun's real answer and accepts the attacker's fake one instead. I reproduced that:
Mailgun says "this message is forged", the attacker says "it's fine", and the attacker wins. The
instruction sheet for the live test can't catch this, because its check is "did you see two
stamps in the data" — and you *will* see two; the code just isn't counting one of them. Both
fixes are small: teach the parser the standard's real spelling rules, and also compare the sender
domain the two sources report, not just their yes/no verdict — the code already does the second
one correctly in the other mode, one file away.

The last thing is bookkeeping, and I'm flagging it because it's now the third time: the README and
the decisions log still describe the *old* design — the one this fix pass deliberately deleted.
Anyone reading them, including you in six months, would believe the gate works differently from
how it does. The progress log and the security report are both correct and current; the security
report is the best-written of the four and the other two should be brought in line with it.

**So: start the live spikes now — capturing real Mailgun payloads is safe today and it is the
single highest-value thing left.** Then make the three small fixes above before you choose a mode
or turn the inbound path on. Nothing here is architectural; it is one parser, one comparison, and
two paragraphs of documentation.


---

## Fix pass 6b status (orchestrator, 2026-09-08) — response to the second re-check

- **N-5 — fixed.** `parseAuthenticationResultsValue` now parses per RFC 8601: comments stripped,
  the authserv-id is the first token before `;` (quoted or bare), the optional version token is
  ignored. A genuine `mxa.host 1; dmarc=fail` or `mxa.host (comment); …` is recognized as ours,
  so a plain-form forgery beside it makes TWO entries ⇒ ambiguous ⇒ `dmarc_unknown`. Tests:
  `tests/unit/mailgun-mapping.test.ts` (four RFC forms) and the N-5 pipeline case in
  `tests/review/dmarc-gate-payloads-a-d.test.ts`.
- **N-6 — fixed.** `combine` now also compares the evaluated domain: if the other source names a
  `dmarcDomain` that differs from the authoritative one (or the authoritative one has none), the
  verdict is `unknown`. Synthetic `dmarc-domain` is lowercased so the comparison is
  case-insensitive like `header.from`. Tests: unit (both modes) + pipeline N-6 (both modes).
- **N-7 — fixed.** README security model states the one-source rule and the residual; ADR 11
  carries the fix pass 6/6b paragraph; README test count updated.

Suite after fix pass 6b: 356 passed, 7 live-gated skips, zero `it.fails`.

---

## Third re-check verdict (Critic, 2026-09-08) — against HEAD `2b39008` (fix pass 6b)

**Scope, as tasked:** verify N-5 (RFC 8601 authserv-id forms), N-6 (domain cross-check in
`combine`), N-7 (documentation drift). Everything else in the per-AC table is **carried
forward from the second re-check, not re-probed this pass** — I am saying so rather than
implying fresh coverage.

**Method:** 40 throwaway mapper probes and 24 throwaway pipeline probes (12 payload shapes ×
both `INBOUND_AUTH_SOURCE` modes) written by me against HEAD, plus a full-suite re-run.
Probes deleted; `src/**` untouched; working tree clean; nothing committed.

**Full suite: 356 passed, 7 skipped, 60 files, zero failures.** (An earlier run of mine showed
4 failures — that was my own artifact: two `vitest` runs racing on one `TEST_DATABASE_URL`. See
N-9.)

### Verdict: **SHIP-READY-FOR-LIVE-SPIKES**

Both fatal-on-flip findings are genuinely closed, in code, verified structurally and end to
end. The remaining items are minor and none of them blocks the live spikes or the default
configuration.

---

### N-5 — **CLOSED.** The parser now follows RFC 8601's grammar, and I could not find a legal genuine form it misses

`parseAuthenticationResultsValue` (`src/adapters/mailgun/mapping.ts:105-137`) strips CFWS
comments, takes the first token before `;`, unquotes it, and ignores anything after it
(including the version token). I fed it every form I could justify from the RFC plus the
adversarial shapes the task named. **All thirteen genuine forms are now recognized** — the
`dmarc=fail` survives into the verdict where it used to be silently discarded:

| genuine form | before (pass 6) | now |
|---|---|---|
| `id; dmarc=fail` | recognized | recognized |
| `id 1; …` version token | **discarded** | recognized |
| `id (Mailgun); …` comment | **discarded** | recognized |
| `(pre) id 1 (post); …` | **discarded** | recognized |
| `"id"; …` quoted | **discarded** | recognized |
| `id (a;b); …` comment containing `;` | discarded | recognized |
| `id (a (b) c); …` nested parens | discarded | recognized |
| `id vX; …` non-digit version token | discarded | recognized |
| tab-separated · folded CRLF+WSP · uppercase id · trailing CFWS | mixed | all recognized |

And the property that matters — **genuine + forged ⇒ ambiguous ⇒ quarantine** — holds for
every pairing, at the pipeline, in `authentication-results` mode:

```
N5  genuine "id 1; dmarc=fail"      + forged plain pass -> quarantined / dmarc_unknown
N5b genuine "id (Mailgun Inc);…"    + forged plain pass -> quarantined / dmarc_unknown
N5c genuine "(pre) id 1 (post);…"   + forged plain pass -> quarantined / dmarc_unknown
N5d genuine quoted "id";…           + forged plain pass -> quarantined / dmarc_unknown
N5e genuine "id (a;b);…"            + forged plain pass -> quarantined / dmarc_unknown
```

I also attacked from the other side — forgery shapes designed to *avoid* being counted so the
genuine one stands alone (which is safe) or to *impersonate* the id:

- `evil.<id>` DNS-suffix forgery → not counted, genuine `fail` wins → `dmarc_fail`. (C″ closed.)
- `(<id>) other.test; dmarc=pass` — id hidden inside a comment → comment stripped, `other.test`
  is the id, not counted. Correct.
- `<id> (x; dmarc=pass` — unbalanced paren, an obvious parser-desync attempt → still counted
  as ours → ambiguous → quarantine.
- `"<id>;x"; …` and `"<id> inc"; …` — `;` and space inside a quoted-string → still counted.
  Over-permissive relative to a strict RFC parser, but the over-permissiveness runs in the
  **fail-closed direction**: more headers counted as ours means more ambiguity means more
  quarantine. An attacker cannot use it to *escape* the count, which is the only direction
  that hurts.
- `; <id>; dmarc=pass` — empty authserv-id → not counted → absent → `unknown`.
- `<id>; none` — RFC no-result form → `dmarc=unknown` → quarantine.

Regression pins are committed: `tests/unit/mailgun-mapping.test.ts:223-256` (four RFC forms)
and `tests/review/dmarc-gate-payloads-a-d.test.ts:192`.

### N-6 — **CLOSED**, with one residual asymmetry (N-10 below)

`combine` (`:223-236`) now compares `dmarcDomain` as well as `dmarc`. Verified in both
directions and both modes:

| case | `authentication-results` | `mailgun-fields` |
|---|---|---|
| genuine field `dom=good.test`, forged A-R `header.from=evil.test` | quarantined `dmarc_unknown` | quarantined `dmarc_unknown` |
| genuine field `dom=evil.test`, forged A-R `header.from=good.test` | quarantined `dmarc_unknown` | quarantined `dmarc_unknown` |
| other names a domain, authoritative has none | `unknown` | `unknown` |
| case difference (`GOOD.TEST` vs `good.test`, either side) | pass (correct — both sides lowercased) | pass |
| trailing-dot FQDN `good.test.` vs `good.test` | `unknown` (over-strict, fail-closed) | `unknown` |
| verdict disagreement `pass` vs `fail` | `unknown` | `unknown` |
| control, fully genuine | queued | queued |

Both of last pass's reproductions now quarantine in the mode where they used to be delivered.
That is a real close. Pin: `tests/unit/mailgun-mapping.test.ts:258,275`.

### N-7 — **CLOSED.** All four documents now state the current design

- `README.md` §Security model (`:112-127`) — states one operator-chosen source, no fallback,
  every ambiguity condition, the domain cross-check, **and the residual**, in that order. The
  `or` model is gone. Test count corrected to 356 (`README.md:18`). ✅
- `docs/decisions.md` ADR 11 (`:130-138`) — carries a "Fix pass 6 / 6b" paragraph naming
  `INBOUND_AUTH_SOURCE`, the absent/ambiguous/present classification, the RFC 8601 parsing, the
  verdict-OR-domain disagreement rule, and the residual. The architectural decision is now
  recorded where an architect would look for it. ✅
- `docs/progress.md`, `docs/security/red-team-report.md` §6 F-1 — were already correct. ✅

---

### New findings

**N-10 (minor, `authentication-results` mode only) — the domain cross-check is one-directional, so the residual is stated slightly narrower than it is.**

`combine:228-233` fires only when the *other* source names a domain. When the authoritative
source names one and the other source is `present` but silent on the domain, there is no check:

```
payload: dmarc=pass            <-- Mailgun's synthetic verdict, no `dmarc-domain`
message-headers: ['Authentication-Results', '<id>; dmarc=pass header.from=good.test']
→ [authentication-results] queued, dmarc=pass, aligned against the attacker's chosen domain
→ [mailgun-fields]         quarantined dmarc_unknown
```

Exploitability depends on an `@unverified-live` assumption — it requires Mailgun to emit
`dmarc=pass` for a `From:` domain the sender is not authorised for, or to emit `dmarc` without
`dmarc-domain`. Neither is known. But the consequence is a documentation over-claim that should
be corrected now, because it is load-bearing for the mode decision: the fix note and
`README.md:122-124` state the residual as "if Mailgun stamps none". It is actually **"if Mailgun
stamps none, *or* stamps a verdict without an evaluated domain."** Two options — tighten the
check (treat "authoritative has a domain, other is present and has none" as a disagreement, at
the cost of false quarantines in the default mode if Mailgun's A-R legitimately omits
`header.from`), or leave the code and widen the sentence. **I recommend widening the sentence
and adding it to spike 3b's record-list** ("does the synthetic `dmarc` field ever appear without
`dmarc-domain`?"), because the default mode is unaffected and tightening trades a hypothetical
for a real false-positive risk.

**N-9 (minor, harness).** `vitest.config.ts` sets `fileParallelism: false`, which correctly
serialises files *within* one run — but `truncateAll()` is global and nothing prevents two
concurrent runs against one `TEST_DATABASE_URL` from wiping each other's fixtures. I produced 4
phantom failures this way before re-running serially. A developer with a watch mode open, or a CI
matrix sharing one database, gets the same confusing red. A Postgres advisory lock around the
suite, or a per-run database name, removes the footgun. Not a product defect.

### Carried-forward, still open (unchanged this pass)

- **C′ residual (declared, by design).** `authentication-results` mode + Mailgun stamps nothing
  + a single forged entry naming the public authserv-id ⇒ delivered. Reproduced again; it is
  documented in the mapper doc comment, the README, ADR 11 and the red-team report, and it is
  precisely what spike 3c exists to settle. Not a finding — a stated precondition.
- **N-8 (minor, stale text).** One of six fixed (`live-spikes.md`'s `INBOUND_DOMAIN` fallback
  line). Still stale: `live-spikes.md:229` ("the F-1 kill switch, **default true**" — it is
  `false`); `src/config.ts:154` ("`container.ts` falls back to `INBOUND_DOMAIN` when this is
  unset" — `container.ts:190` falls back to `mailgun.org`); `.env.example:69-73` and
  `config.ts:206` still justify the authserv-id rule with "public and guessable", a premise
  runbook 4a corrected (the right reason is that `INBOUND_DOMAIN` is *our* domain and would
  never match a genuine stamp); `run-and-deploy.md:97` still describes `/readyz` as
  `{ok, db, pendingJobs}`; `tests/setup/container.ts:69` still carries `?? config.INBOUND_DOMAIN`,
  the fallback production deleted.
- **Spike 3c wording (minor, downgraded).** `live-spikes.md:275-277` still reads "shows TWO
  entries naming the authserv-id **and** the pipeline quarantines" — a conjunction an operator
  can satisfy by eye. My fix item asking for a standalone hard stop ("if it was DELIVERED rather
  than quarantined, STOP") was not taken. This mattered a great deal last pass, because the code
  and the operator's eye disagreed about what counts as an entry; **now that N-5 is fixed they
  agree**, so the wording is a robustness nit rather than a trap. Still worth one sentence.
- **N-3 (minor).** A 2xx exchange with an unreadable body is classified `PermanentError`.
- **N-2 (minor).** `unconfirmed` deliveries are counted, logged and badged; no resend action.

### Final per-AC verdict

| AC | Last pass | Now | Note |
|---|---|---|---|
| **AC-U1** three artifacts | MET | **MET** | carried |
| **AC-U2** flag OFF → raw Zoho link | MET w/ caveat | **MET with caveat** | carried; spike-1 hypotheses |
| **AC-U3** flag ON → branded page | MET w/ caveat (minor) | **MET with caveat (minor)** | carried; residual is spike 4 |
| **AC-U4** expiry enforced | MET w/ caveat | **MET with caveat** | carried |
| **AC-R1** DMARC-fail/absent → no delivery | MET in default; **NOT MET** in `authentication-results` | **MET in the default config; MET-with-declared-residual under `authentication-results`** | N-5 and N-6 now quarantine in BOTH modes. What remains in the alternative mode is the declared C′ precondition (Mailgun stamps nothing) plus N-10's narrow extension of it. Requires an explicit operator flip; kill switch defaults off. |
| **AC-R2** file chosen only from the token | MET | **MET** | carried; strongest surface |
| **AC-R3** delivery to the verified From only | MET w/ caveat | **MET with caveat** | structurally airtight; "verified" inherits AC-R1 |
| **AC-R4** ≤20 MB attach / larger Drive share | MET w/ caveat | **MET with caveat** | carried; Google account-type fork open |
| **AC-R5** custom message + display name | MET | **MET** | carried |
| **AC-R6** signature required | MET | **MET** | carried |
| **AC-E1** auto-duplicate at the cap | MET w/ caveat | **MET with caveat** | carried; spike 2 |
| **AC-E2** idempotent, serialized per (tenant, file) | MET | **MET** | carried |
| **AC-A1** file-scoped access only | MET | **MET** | carried |
| **AC-A2** every delivery audit-logged | MET w/ caveat (minor) | **MET with caveat (minor)** | carried; no resend action |
| **AC-A3** tenant isolation | MET | **MET** | carried |

### What is genuinely good in this pass

The N-5 fix is the right fix, not the minimum one. It would have been easy to special-case the
two forms I named in the finding; instead the parser was rewritten against the RFC's actual shape
— comments first, then the token, then ignore the version — which is why it also survives the
five adversarial forms I invented *after* filing the finding (comment containing `;`, nested
parens, unbalanced paren, quoted-with-`;`, quoted-with-space). Fixing the class rather than the
instance is the difference between a patch and engineering. The N-6 fix likewise lowercases the
synthetic `dmarc-domain` at the source rather than at the comparison, so the case-insensitivity
holds for every future reader of that field. And N-7 was not just patched but patched in the
*right shape*: README and ADR 11 both now follow the property → precondition → residual template,
which is the third time I have asked for it and the first time all four documents do it.

### Plain language, for the founder

Both problems I raised last time are fixed, and fixed properly. I re-ran the two attacks that beat
the system last round and both are now blocked; then I invented five more variations of the same
trick, and the code blocked all of those too — which tells me the fix addressed the underlying
mistake rather than the two examples I happened to give. Genuine mail still gets through in every
form I tried. The README and the decisions log now describe the system that actually exists, which
is the third time I asked and the first time it is true across all four documents.

**My verdict: start the live spikes.** There is nothing left blocking them, and capturing a real
Mailgun payload is now the single highest-value thing you can do — every remaining uncertainty in
the email gate is a question only a real payload can answer.

Two small things to carry into the spikes, neither urgent. First, when you write down what the
real payload contains, add one question to the list: does Mailgun ever report a DMARC result
*without* naming the domain it checked? If it does, the optional mode has one more narrow gap
than we currently describe — the default mode is unaffected either way. Second, there is a
handful of leftover sentences in the config comments and one runbook line that describe behaviour
that was deleted two fix passes ago. Harmless today, misleading in six months; worth ten minutes
sometime, not now.

---
---

# Fix pass 7 status (backend-engineer, 2026-09-10)

Scope: the eight Minor/N-3/N-8 items the founder asked to close out, none of which were
individually assigned to fix passes 5/6/6b and were carried forward each time as "deferred, not
dropped." `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm
gen:ledger -- --check` green throughout, zero `it.fails`. Suite: **369 passed, 7 live-gated
skips, 63 files, zero failures** (up from 356/60 at the start of this pass — 13 new tests, no
existing test deleted or weakened to make room for them).

1. **Quarantine cap silence (F-7) — FIXED.** Past `QUARANTINE_PER_TOKEN_PER_HOUR`,
   `RequestPipeline.quarantine` (`src/domain/request-pipeline.ts`) now calls
   `deliveries.incrementSuppressed` (`src/db/repositories/deliveries.ts`) instead of returning
   silently: ONE aggregate row per `(file_id, calendar hour)` — `outcome='quarantined'`,
   `reason='suppressed'`, an incrementing `suppressed_count` — written/bumped atomically via a
   partial unique index (migration `0006`, `ON CONFLICT (file_id, date_trunc('hour', created_at AT
   TIME ZONE 'UTC'))`). Sender-facing table shows "N נוספות הושתקו"
   (`src/lib/presentation.ts`'s `deliveryAddressLabel`, wired into both the HTML route and the
   JSON deliveries feed island.js polls). RT-20's bound is now `cap + 1` rows, not `cap` — one
   extra row no matter how many over-cap requests arrive, never unbounded. Tests:
   `tests/review/quarantine-suppression-and-null-requester.test.ts` (aggregate row shape,
   same-hour reuse), `tests/redteam/addressing-and-routing.test.ts` RT-20 updated to the new bound.
2. **`requester_address` on unparseable/ambiguous From — FIXED.** All three quarantine call sites
   in `request-pipeline.ts` that used to fall back to `msg.recipientRaw` (the file's OWN inbound
   address, not anything about the requester) now record `null` — the column is nullable as of
   migration `0006`. UI renders "לא ניתן לזהות שולח" (same `deliveryAddressLabel` helper as #1).
   Test: `tests/review/quarantine-suppression-and-null-requester.test.ts`'s third case (two `From`
   addresses → `from_address_invalid` → `requester_address IS NULL`).
3. **Logging (console → pino) — FIXED.** New `src/logger.ts` (`createLogger`, the ONE redaction
   list, previously duplicated only in `app.ts`). `server.ts`/`worker.ts` build one instance and
   pass it to `buildContainer` as `container.logger`; `app.ts` passes the SAME instance to Fastify
   via `loggerInstance` (Fastify 5 renamed the plain-instance option; a `FastifyInstance` cast is
   needed at that one call site — a type-level-only friction from pino's logger type not
   structurally matching `FastifyBaseLogger`, not a behavior change) so HTTP and job/domain logs
   share one format and one redaction list. Every `console.log`/`console.error` in `src/**` outside
   `src/db/migrate.ts` (excepted by the task) is gone — `worker.ts`, `jobs/loop.ts`, `jobs/queue.ts`,
   `jobs/handlers/file-expire.ts`, `domain/files.ts`, `server.ts` all now log through
   `container.logger` (or, for the two "config/logger construction itself may have failed" top-
   level `.catch`s in `server.ts`/`worker.ts`, a bare `createLogger('fatal')` — still pino, never
   `console`). `src/adapters/mailgun/fake.ts`'s one `console.info` is untouched: it is `.log`/
   `.error` in name only by accident of English, is dev-only terminal output with no injected
   logger available to a semantic fake, and was explicitly out of scope ("console.log/error").
   No new dedicated test — this is a mechanical, typecheck-verified substitution with no new
   branching behavior; the existing suite (which exercises every one of these code paths) passing
   with no `console.*` calls left standing (`grep -rn "console\.\(log\|error\|warn\)" src/` — zero
   hits outside `migrate.ts`) is the verification.
4. **N-3 (2xx-with-unreadable-body misclassified `PermanentError`) — FIXED.** `src/adapters/
   mailgun/real.ts`'s `send()`: a 2xx response is now ALWAYS a definite accept —
   `providerMessageId: json?.id ?? null` — regardless of whether the body was readable, parseable,
   or carried an `id` field. `OutboundMailPort.send`'s return type widened to
   `{providerMessageId: string | null}` (no caller persists or branches on this value). Tests:
   `tests/contract/mailgun-wire.test.ts`'s two new cases (no `id` field; non-JSON body) replace the
   old pinned-wrong-behavior test that asserted `PermanentError`.
5. **Expiry mode fidelity — FIXED.** `files.expiry_mode`/`expiry_days` (migration `0006`) persist
   the settings FORM's own choice, independent of the derived `expires_at` timestamp
   `Settings.resolveExpiry` computes from it. `SettingsService.updateSettings` sets both together;
   `FilesService.createStaged` seeds every new file `('days', DEFAULT_EXPIRY_DAYS)`;
   `http/routes/files.ts`'s GET read model uses `file.expiry_mode`/`file.expiry_days` instead of
   guessing `expires_at ? 'custom' : 'none'` (the exact bug this item names — an ordinary
   `days`-mode expiry, which every file has by default, always rendered as "custom date"); the
   `expiryDays` number input in `file-detail.eta` is pre-filled from the stored value instead of a
   hardcoded `value="30"`. Test: `tests/review/expiry-mode-fidelity.test.ts` (default-days
   rendering, switching to custom, switching to none — each asserted against both the DB row and
   the rendered HTML).
6. **Per-tenant folders (Zoho + Google audit) — FIXED, both adapters.** Zoho: `ensureFolder(name,
   parentId)` (`src/adapters/zoho/real.ts`) — `POST {apiBase}/files`, a JSON:API envelope modeled
   on this file's own conventions, `@unverified-live`, cached in-process per tenant folder name —
   wired into `upload()`, which used to ignore `tenantFolder` entirely (`void tenantFolder;`, every
   upload landing in the one shared `ZOHO_TEAM_FOLDER_ID`). Ordered AFTER the F-G large-file-
   refusal check, not before, so a refused oversized upload still attempts zero requests, not one.
   Auditing the Google adapter for the same gap (as the task asked) found it too — `uploadResumable`
   took no tenant-folder parameter at all despite its own doc comment already claiming "into the
   tenant's folder"; fixed the same way (`ensureFolder` on `GoogleDriveShare`, `DriveSharePort.
   uploadResumable` widened to take `tenantFolder` as its first argument, matching
   `FileStorePort.upload`'s convention). Drive's own `files.copy` keeps a copy's source parent when
   none is given, so `SharingEngine`'s auto-duplicated copies land in the same tenant folder for
   free — no change needed there. Both fakes (`zoho/fake.ts`, `google/fake.ts`) gained a matching
   `folders`/`ensureFolder` cache so tests can assert isolation AND caching (not one folder created
   per upload). Tests: `tests/integration/isolation.test.ts`'s new case (two tenants, three uploads,
   same tenant shares one folder in BOTH stores, different tenants get different folders, exactly
   one folder created per tenant despite multiple uploads); `tests/contract/zoho-workdrive-wire.test.ts`'s
   new case (request shape + cache-reuse assertion) and updated `parent_id` assertions;
   `tests/contract/google-drive-wire.test.ts`'s updated case (folder-create request shape +
   the upload session's parent is the resolved tenant folder, not the raw root).
7. **Resend action (critic N-2, "no way to resend") — FIXED.** `POST
   /files/:id/deliveries/:deliveryId/resend` (`src/http/routes/files.ts`) — session + CSRF,
   tenant-scoped (`AuditService.resendDelivery` looks the delivery up by `(tenantId, fileId,
   deliveryId)` together, so a cross-tenant or cross-file id 404s exactly like every other lookup
   in this file, AC-A3), restricted to `failed`/`unconfirmed` outcomes (409 otherwise), rate-limited
   per file (`RateLimitService.checkResend`, a new bucket on the SAME `RATE_FILE_PER_HOUR` ceiling
   the inbound path's own file bucket uses, on a distinct key so the two budgets can't bleed into
   each other; 429 when exceeded). Creates a NEW `deliveries` row (`queued`, `reason:
   'resend_of:<originalId>'`, same requester address, dmarc copied from the original) and enqueues
   `delivery.fulfill` for it in ONE transaction — the same append-then-complete outbox shape gate
   10 of the inbound pipeline uses (architecture.md §3 invariant 4). The deliveries table shows a
   "שלח שוב" button on resendable rows (`file-detail.eta`), a plain form POST (works with no JS,
   matching this app's other mutating actions). Tests: `tests/review/resend-delivery.test.ts` — all
   four cases the task named (happy path including the enqueued job actually sending, cross-tenant
   404, wrong-outcome 409) plus a fifth (`unconfirmed` is resendable, not just `failed`).
8. **N-8 (stale text in the safety documents) — FIXED, the five items the critic's last pass left
   open** (one of six was already fixed before this pass, per the critic's own accounting).
   `docs/runbooks/live-spikes.md:229` ("the F-1 kill switch, default true") now states the true
   default (`false`) and that the spike needs it off anyway, not "set specially for the spike."
   `src/config.ts`'s `MAILGUN_AUTHSERV_ID` field comment and the `superRefine` validation message
   no longer claim `container.ts` falls back to `INBOUND_DOMAIN` (deleted in fix pass 5) or frame
   the authserv-id's required-ness as being about secrecy — corrected to the real reason
   (`INBOUND_DOMAIN` is a different, public value that would never match a genuine stamp, not a
   guessable secret one). `.env.example`'s matching comment gets the same correction. `docs/
   runbooks/run-and-deploy.md` item 7's `/readyz` shape updated from the fix-pass-4-era `{ok, db,
   pendingJobs}` to the current `{ok, db, pendingJobs, sweepsHealthy, sweeps, strandedExpiries,
   unconfirmedDeliveries}`, with a note that the two newer counters are operator signals, not
   readiness failures. `tests/setup/container.ts:69`'s `?? config.INBOUND_DOMAIN` (the deleted
   production fallback, still living on in the test harness — harmless today since `buildTestConfig`
   always sets `MAILGUN_AUTHSERV_ID`, but exactly the kind of dead code the critic flagged) now
   mirrors `container.ts`'s real fallback (`mapping.ts`'s own hardcoded default) instead. No
   dedicated test for doc/comment text; `pnpm test`'s full green run plus a manual re-grep for each
   named stale string (all now absent) is the verification for a documentation-only item.

**Not touched, and correctly out of scope for this pass:** F-D (the confirm-link founder fork,
still open on the record), the `authentication-results`-mode residual (C′/N-10, both declared and
gated on spike 3c), N-9 (the shared-`TEST_DATABASE_URL` concurrency footgun — QA-owned files per
this pass's task boundary; observed directly during this pass as two flaky, non-reproducing
`files_tenant_id_fkey` failures under concurrent `pnpm test` runs against the shared dev database,
each of which passed cleanly in isolation, consistent with N-9's description rather than a
regression in the code this pass touched).

**Regenerated:** `docs/verification-ledger.md` (two new `@unverified-live` markers — Zoho's and
Google's new `ensureFolder`, item 6 — 14 → 16 unverified-live, 0 verified-live, unchanged).
**Lessons filed:** one, `docs/lessons.md` 2026-09-10 — `date_trunc('hour', timestamptz)` is
STABLE, not IMMUTABLE, and cannot back an index/`ON CONFLICT` target without first pinning the
time zone (`AT TIME ZONE 'UTC'`) to make the expression immutable; hit and fixed while building
item 1's aggregate-row upsert, before any migration reached a live database.

---
---

# Fourth pass verdict (polish) — Critic, 2026-09-10 — against HEAD `e2ee898`

**Scope, as tasked:** did fix pass 7 + the QA polish commit erode anything the third re-check
marked *"genuinely strong — do not let the fix pass erode"*, and did the new resend action
introduce a new way to make the system send a file? Everything else in the per-AC table is
**carried forward from the third re-check, not re-probed**, except AC-U4 and AC-A2/A3, which
this pass's changes touched directly and which I did re-probe.

**Method:** read `git diff 00dfa99..HEAD` in full; ran `pnpm test` twice against real Postgres;
wrote six throwaway probes (resend amplification, resend idempotency, cross-tenant/cross-file/
CSRF/session on the new route, resend against an expired file, non-UUID path ids, and migration
0006's effect on a pre-existing row); hand-drifted `docs/verification-ledger.md` to test whether
`gen:ledger --check` actually detects drift, then restored it. All probes deleted, `src/**`
untouched, nothing committed.

**Suite: 369 passed, 7 live-gated skips, 63 files, zero failures** — matches the claim. I also
re-ran with the three untracked `*.probe.test.ts` files moved out of the tree and got the
identical 369/63, so the reported count is the committed tree's count, not inflated by strays.

### Verdict: **FIX-THEN-SHIP**

Nothing I praised was eroded. `SharingEngine` and its 50-concurrent proof were not touched at all.
The resend action is, on the security axis, built correctly — I could not make it cross a tenant
boundary, escape the gate re-check, or touch a `quarantined` row. But the pass introduced **one
regression that destroys a safety control on every file that predates it** (R-1, reproduced), and
**one abuse surface that routes around the only rate-limit bucket that protects a recipient**
(R-2, reproduced). Both fixes are small. Fix R-1 before migration 0006 reaches any database that
already has files; fix R-2 before a customer has the button.

---

### R-1 (serious; **fatal on any non-empty database**) — migration 0006 adds `expiry_mode` with no backfill, so every pre-existing file is mislabelled "no expiry" and the next save deletes its real expiry

`src/db/migrations/0006_quarantine_suppression_and_expiry_mode.sql` ends with:

```sql
ALTER TABLE files ADD COLUMN expiry_mode text NOT NULL DEFAULT 'none'
                              CHECK (expiry_mode IN ('none', 'days', 'custom'));
```

There is no `UPDATE`. Postgres's fast-default fills every existing row with the literal `'none'`
regardless of whether that row has a real `expires_at` — which, in this app, nearly all of them do
(`FilesService.createStaged` gives every file `DEFAULT_EXPIRY_DAYS`). The row is then
self-contradictory: `expiry_mode='none'`, `expires_at=<a real date>`.

`src/http/routes/files.ts`'s new read model trusts the column (`expiryMode: file.expiry_mode`),
and `file-detail.eta:147` checks the radio from it. Reproduced against HEAD, on a row put in
exactly the state the migration leaves behind:

```
P6 page pre-selects "no expiry" radio = true;  DB expires_at = Sat Oct 10 2026
P6 save (renamed the file, nothing else) status=302 -> expires_at = null (mode none)
```

Two harms, in order of severity. **(a)** The settings form always submits `expiryMode`, so *any*
save — renaming the file, editing the allowlist, changing the message — silently sets
`expires_at = NULL` and the file becomes permanent. That is a consent/safety invariant moving in
the **looser** direction with no user intent and no record, which `docs/research/03` forbids
outright. **(b)** Until that save, the file page tells the sender "no expiry" about a file that
will in fact stop working in 30 days — a false statement about the control on the page whose
whole job is to state it.

The precondition is "a `files` table with rows created before 0006." Production does not exist yet,
so this is latent rather than live — but every dev and staging database on this project has such
rows today, the live spikes will run against one of them, and `run-and-deploy.md` does not warn
that this migration requires an empty table.

**Do this:** ship the backfill as a **follow-up migration `0007`**, not by editing 0006 — 0006 has
already been applied to the dev/test databases on this project, and an edited migration does not
re-run. `UPDATE files SET expiry_mode = 'custom' WHERE expires_at IS NOT NULL AND expiry_mode =
'none';`. `'custom'`, not `'days'`: the original day count genuinely is unrecoverable from a
timestamp, and `'custom'` renders the true date instead of inventing a number. Pin it with a
migration test that applies 0001–0006, inserts a file with an `expires_at` and `expiry_mode='none'`,
applies 0007, and asserts the row is no longer self-contradictory. (This is the code reviewer's own
prescription, arrived at independently; I checked it and it is the right shape — in particular the
`AND expiry_mode = 'none'` guard, which makes the backfill safe to run after any file has already
been edited post-0006.)

**Correction, and a note on convergence.** While I was probing, the code reviewer's polish-pass
review landed in `docs/reviews/code-review.md` carrying this same defect as its finding 1 [HIGH],
with the same reproduction and a better fix (a follow-up migration rather than an edit to 0006 —
adopted above). I had initially written this up as a process failure on the theory that the
reproduction existed only as an untracked probe in the working tree; that was wrong, and the
untracked `*.probe.test.ts` files are that review's in-flight pins, not abandoned ones. Two
reviewers who did not talk to each other reproduced the same regression from opposite directions
— the reviewer from the migration, me from the settings form — which is the loop working, and I
am recording it that way rather than leaving my first read of it standing.

### R-2 (serious) — resend routes around the one rate-limit bucket that protects the recipient, and is not idempotent

The security review of the new route comes out clean, and I want to say that before the criticism:

| attack | result |
|---|---|
| resend a delivery id belonging to **another tenant** | **404** (`findById` filters `tenant_id AND file_id AND id`) |
| resend a delivery id belonging to **another file of the same tenant** | **404** |
| resend a **`quarantined`** row | **409** |
| resend a **suppressed aggregate** row (null requester) | **404** — no address to send to |
| resend with **no CSRF token** / **no session** | **403** / **403** |
| resend against an **expired** file | accepted, then the job's `checkGatesOrTerminal` re-ran and finalized `expired/expired` — **0 mails sent** |
| does it re-run the gates? | yes — resend enqueues the same `delivery.fulfill`, so the expiry, `status`, and allowlist gates all re-run at send time; DMARC is copied from the original, which is the only defensible choice since there is no new inbound message to authenticate |

So: it cannot be used across a tenant boundary, cannot resurrect a quarantined request, and cannot
outrun the sender's emergency controls. That part is right.

**What it can do is amplify.** `RateLimitService.checkResend` consults exactly one bucket,
`resend:<fileId>`, on the `RATE_FILE_PER_HOUR` ceiling. It never touches — never even increments —
the `requester`, `domain` or `tenant` buckets. `RATE_REQUESTER_PER_HOUR` defaults to **5** and
exists for one reason: no single address gets bombed. Reproduced, one signed-in session, one
`failed` row, one loop:

```
P1  12 clicks on the SAME failed row -> accepted=12  rate_limited=0  mails to ONE address=12
P2  caps {requester:5, file:60, tenant:300}
P2  accepted_resends=60  -> 60 mails to ONE address in one hour
```

60 is **12× the per-recipient ceiling**, and because the bucket is keyed per file, a tenant with
N files gets N × 60/hour while `RATE_TENANT_PER_HOUR: 300` is never consulted at all. For a product
whose entire value proposition is deliverability, an abuse path that mails one address 60 times an
hour out of the shared sending domain is a reputation risk, not a theoretical one.

The everyday version is worse than the abuse version. The original row stays `failed` forever, so
the button stays live while the resends it already created are still queued: **a double-click sends
two copies, a slow page and three clicks sends three.** There is no in-flight guard and no dedupe —
`dedupeKey: delivery.fulfill:resend:<newDeliveryId>` is generated per request, so it dedupes
nothing across requests.

**Do this, in order of value:** (1) refuse the resend with a 409 when a non-terminal delivery
(`queued`/`sending`/`dispatching`/`granted`) already exists for the same `(file_id,
requester_address)` — this alone kills the double-click case; (2) key the resend bucket on
`resend:<fileId>:<requesterAddress>` at `RATE_REQUESTER_PER_HOUR`, not per file at
`RATE_FILE_PER_HOUR`, so the bound sits on the identity that suffers the harm; (3) increment the
`tenant` bucket on a resend so one tenant's total hourly footprint stays bounded however it is
sliced. The reasoning in the current doc comment ("a distinct key so the two budgets can't bleed
into each other") is sound about *isolation* and silent about *who the cap protects* — that is the
mistake.

**Fix-status note (fix pass 9).** Both halves fixed, in the order this finding gave them less its
first, cheaper-to-verify item:

- **In-flight guard.** `AuditService.resendDelivery` now calls a new
  `deliveries.insertQueuedIfNotInFlight` instead of the old unconditional `insertQueued` —
  `INSERT ... ON CONFLICT (file_id, requester_address) WHERE reason LIKE 'resend_of:%' AND outcome
  IN ('queued','sending','dispatching','granted') DO NOTHING RETURNING *` against a new partial
  unique index, migration `0008_resend_in_flight_guard.sql`. No row back maps to a new
  `ResendResult` case, `'in_flight'`, which the route answers `409`. This is the insert deciding
  the race, not a read-then-insert check racing itself: 12 concurrent clicks on one `failed` row
  now produce exactly one `302` (and 11 `409`s), one new `deliveries` row, and one mail —
  `tests/review/resend-delivery.test.ts`, "12 concurrent resend clicks ... create exactly one new
  delivery and send exactly one mail". Scoped to `reason LIKE 'resend_of:%'` specifically so the
  ordinary inbound pipeline — which creates a fresh `queued` row per genuine request with no such
  guard, on purpose, and never has — is untouched; pinned by "the resend in-flight guard does not
  change the inbound pipeline's own (unrelated) duplicate-request behavior" in the same file, two
  genuine webhook deliveries from one requester while the first is still `queued` still both land.
- **Rate gates.** `RateLimitService.checkResend` no longer consults only `resend:<fileId>` at
  `RATE_FILE_PER_HOUR`. It now calls `checkInboundRequest` — the exact function the inbound webhook
  path itself calls — so a resend clears the same `requester`/`domain`/`file`/`tenant` gates a
  genuine inbound request for that address would (closing the specific gap this finding named: the
  `tenant` bucket was never touched at all), plus one resend-specific bucket,
  `resend:<fileId>:<requesterAddress>` at `RATE_REQUESTER_PER_HOUR` exactly as suggested — keyed on
  the identity that suffers the harm, not the file. Exceeding either writes a `rate_limited` audit
  row with `reason: 'resend'`, same shape the inbound pipeline's own rate gate already writes. Since
  the shared `requester` bucket is keyed on the (normalized) address alone, not per file, it is
  provably shared across a sender's files, not per-file re-issued budget — proven by "resends to two
  different files by the same requester share the shared per-requester bucket" (3 allowed total
  across two files at `RATE_REQUESTER_PER_HOUR: 3`, the 4th `429` regardless of which file it hits)
  and "a 6th resend to the same requester within the hour is rate_limited (429) and writes an audit
  row" (5 through at the default `RATE_REQUESTER_PER_HOUR: 5`, the 6th `429` with the audit row
  present). The reproduction this finding gave (60 mails to one address in an hour) is no longer
  reachable: the shared `requester` bucket caps that address at 5 exactly as it always capped
  genuine inbound traffic to it.

Not done, and not claimed: the two rate-gate tests above run resends sequentially (draining each
resend's job before the next click) specifically so the in-flight guard and the rate gate can each
be verified in isolation — no test here exercises the interaction between a rate-gate rejection and
a concurrent in-flight collision on the exact same request, though nothing in the implementation
gives that combination a code path either check doesn't already own on its own. `pnpm typecheck &&
pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm gen:ledger -- --check` all green,
388 passed / 7 skipped (four new), zero `it.fails`.

### R-3 (minor) — `ensureFolder` has no cross-restart identity and no create-race guard, in both adapters

Independently filed by the concurrent code review as its finding 2 [MEDIUM-HIGH]; we converged
here too. Both `ZohoFileStore.ensureFolder` and
`GoogleDriveShare.ensureFolder` cache the resolved folder id **in process memory only** and create
unconditionally on a miss — there is no lookup-by-name and nothing is persisted. So every process
restart, and every additional instance, creates *another* folder for a tenant that already has one,
forever; and two concurrent first uploads for one tenant race and create two. The server and the
worker are separate processes that both build containers, so this fires on day one, not only after
a restart. `tests/integration/isolation.test.ts`'s "exactly one folder created per tenant despite
multiple uploads" is true only within one process lifetime, which is narrower than the property the
test name claims.

Consequences are bounded — folder ids are stored per upload, so nothing becomes unreachable — but
files scatter across duplicate folders, and whether WorkDrive rejects a duplicate folder name
outright is `@unverified-live`, i.e. unknown. **Do this:** persist the resolved folder id on the
tenant row (one column, one write, survives restarts and makes the race a unique-constraint problem
instead of a duplicate-folder problem), and add one line to spike 1's record-list: *"create a folder
with a name that already exists — 409, or a silent second folder?"*

### R-4 (minor) — documentation drift, again, and one guarantee that is now false

This is the fourth consecutive pass in which I file this, and the lesson from the second re-check
(*"treat a stale security claim as a failing test, not a typo"*) predicted it.

- **`README.md:18`** — "**356 tests pass**". It is 369, plus a browser e2e suite the README does
  not mention at all.
- **`README.md:20-21`** ("generated from those markers, CI checks it can't drift") and
  **`docs/verification-ledger.md:3`** ("CI runs `pnpm gen:ledger --check` and fails if this file is
  out of date") — **both are false today.** `.github/workflows/ci.yml:93` carries
  `continue-on-error: true`, under a TODO that claims the generator "only prints 'not implemented'
  and always exits 0". I tested that claim: the generator is implemented and correct — I drifted the
  ledger by hand and `--check` exited **1**. So the honesty infrastructure's CI teeth exist, work,
  and are switched off, while two documents promise they are enforcing. One-line fix: delete
  `continue-on-error` and the stale TODO. Of everything in this section, fix this one — it is the
  exact mechanism I called "better than most funded startups ever build," and right now it is
  decorative.
- **`docs/progress.md`** — no fix-pass-7 entry at all; the final line still reads "356 tests green
  … ledger 0 verified-live / 14 unverified-live" (now 369 and 16).
- **`docs/founder-summary.md:4`** — "31 commits · 356 tests"; the body describes a product with no
  resend action, no suppression rows, no per-tenant folders and no browser test. It is the single
  most founder-facing document and it describes the pre-polish system.
- **`docs/decisions.md`** — 20 ADRs, none for the resend action. A new user-visible surface that
  sends mail is an architectural decision, and its non-obvious parts (which outcomes are eligible,
  why DMARC is copied rather than re-evaluated, which bucket bounds it) belong where an architect
  would look.
- **N-9** is closed as an *opt-in* (`TEST_DB_PER_RUN=1`, default off) with a helpful tip printed by
  `scripts/dev-db.sh`. That is a reasonable engineering choice, but the default `pnpm test` path —
  the one the runbook and my own task instructions use — still shares one database, so the footgun
  that produced my four phantom failures is mitigated, not removed. Worth one honest sentence in the
  QA report rather than a checkmark.

### R-5 (minor; **pre-existing, my miss in three prior passes**, not this pass's fault)

A non-UUID path id returns **500**, not 404, on every tenant-scoped route — `GET /files/:id`,
`POST /files/:id/delete`, `POST /files/:id/settings`, `GET /api/files/:id/deliveries` and the new
resend route alike (probe P5, all five: `500`). A Postgres `22P02 invalid input syntax for type
uuid` escapes as an unhandled error. It contradicts the contract `src/http/routes/files.ts:49-51`
states in its own doc comment ("a wrong tenant gets a plain 404, never a distinguishing detail"),
it distinguishes "malformed" from "not yours" to an unauthenticated-shaped probe, and it fills logs
with stack traces on trivially malformed URLs. One shared UUID format check in the route schema
turns all five into 404s.

### Housekeeping

Five untracked `*.probe.test.ts` files are sitting in `tests/review/` — the concurrent code
review's own probes. They are not committed and the suite does not pick them up (verified: 369/63
with and without them), so the reported test count is not inflated. They should be deleted (or
promoted to committed `it.fails` pins) when that review closes, so the next reader cannot mistake
an in-flight probe for a dropped finding — which is exactly the mistake I made mid-pass.

---

### Per-AC verdict (against HEAD `e2ee898`)

| AC | Third re-check | Now | Note |
|---|---|---|---|
| **AC-U1** three artifacts | MET | **MET** | carried |
| **AC-U2** flag OFF → raw Zoho link | MET w/ caveat | **MET with caveat** | carried; spike 1 |
| **AC-U3** flag ON → branded page | MET w/ caveat (minor) | **MET with caveat (minor)** | carried; spike 4 |
| **AC-U4** expiry enforced | MET w/ caveat | **REGRESSED — NOT MET for any file created before migration 0006** | R-1, reproduced: such a file renders as "no expiry" and the next settings save deletes its real `expires_at`. MET for files created after 0006. The enforcement machinery itself (sweep, job, `/readyz.strandedExpiries`) is untouched and still sound. |
| **AC-R1** DMARC-fail/absent → no delivery | MET default; declared residual in `authentication-results` | **unchanged — carried, not re-probed** | this pass did not touch the gate; C′/N-10 still gated on spike 3c |
| **AC-R2** file chosen only from the token | MET | **MET** | carried; resend adds no token-resolution path |
| **AC-R3** delivery to the verified From only | MET w/ caveat | **MET with caveat** | re-probed: resend can only target the original row's own `requester_address`, is refused when that is `null`, and copies the original's DMARC verdict rather than inventing one |
| **AC-R4** ≤20 MB attach / larger Drive share | MET w/ caveat | **MET with caveat** | carried; per-tenant folders now real (R-3 is about folder identity, not routing) |
| **AC-R5** custom message + display name | MET | **MET** | carried |
| **AC-R6** signature required | MET | **MET** | carried |
| **AC-E1** auto-duplicate at the cap | MET w/ caveat | **MET with caveat** | carried; `SharingEngine` untouched by this pass, 50-concurrent proof still green |
| **AC-E2** idempotent, serialized per (tenant, file) | MET | **MET** | carried |
| **AC-A1** file-scoped access only | MET | **MET** | carried |
| **AC-A2** every delivery audit-logged | MET w/ caveat (minor: no resend, silent suppression) | **MET** — **upgraded** | both caveats genuinely closed: the suppression aggregate row ends F-7's silence at a `cap + 1` bound, and every resend writes its own row with `reason: resend_of:<id>`. The R-2 rate-limit finding is an abuse bound, not an audit gap — the rows are all there. |
| **AC-A3** tenant isolation | MET | **MET** | re-probed on the new surface: cross-tenant 404, cross-file 404, no-CSRF 403, no-session 403, and only the tenant's own row was ever created |

### What is genuinely good in this pass — and was not eroded

- **`SharingEngine` is untouched.** `git diff 00dfa99..HEAD -- src/domain/sharing-engine.ts` is
  empty, and its 50-concurrent-`share()` proof is still green. The best code in the repository was
  left alone, which is the correct instinct during a polish pass.
- **The resend action's security shape is right.** Tenant *and* file in one lookup, an eligibility
  whitelist rather than a blacklist, a null-requester refusal, insert-and-enqueue in one
  transaction matching gate 10's outbox shape, and — the part I most expected to be skipped — it
  re-runs the expiry/status/allowlist gates at send time by going through the same job rather than
  sending inline. I attacked it seven ways and it held on all seven. The gap is a rate-limit
  *policy* choice, not a hole in the mechanism.
- **The suppression aggregate is well built.** A partial unique index with a correctly-immutable
  `date_trunc('hour', created_at AT TIME ZONE 'UTC')` expression, an atomic `ON CONFLICT DO UPDATE`
  with a target that matches the index exactly, a `cap + 1` bound, and the immutability trap filed
  as a lesson the same day it was hit. That is the self-improving loop working as designed.
- **The blocking browser e2e job.** It installs a real Chromium, runs a real server against real
  Postgres, and carries **no** `continue-on-error` — a genuine end-to-end gate, not a decorative one.
- **The single pino redaction list.** One `REDACT_PATHS`, one `createLogger`, shared by Fastify and
  the container so HTTP and job logs cannot drift apart. I checked every new log call site for a
  raw address, token or secret at an unredacted path and found none.

### Lessons filed

Two, appended to `docs/lessons.md` (2026-09-10): the additive-column backfill rule (a column that
refines information already held in another column must ship a backfill derived from it in the same
migration, plus a test that seeds a pre-migration row), and the new-trigger/rate-limit-identity rule
(a new trigger for an existing side effect must be bound to the same identity buckets as the
original trigger). A third, about probes left untracked, was drafted and then retracted — see the
correction under R-1.

---

### Plain language, for the founder

**What "done" now means.** Every small thing I listed over three passes is genuinely closed, and
I could not break the new resend button in any of the seven ways I tried to — it will not send
another customer's file, will not resurrect a request the system already refused, and will not
send a file whose expiry you triggered a second earlier. The concurrency engine, which is the best
code here, was not touched. But the polish pass introduced two problems of its own, which is the
ordinary risk of a polish pass and the reason this gate exists. The first is the one that matters:
a database change in this pass tells every file you have *already* uploaded that it has no expiry
date, when it does — and the next time you save anything on that file's settings page, its real
expiry is silently deleted and the file becomes permanent. Nobody is affected today because nothing
is live, but it will fire on your own test files the moment you run the migration, and expiry is a
promise you make to the person you sent a file to, so it is not a promise the system may quietly
withdraw. The fix is one line of SQL plus a test. The second is that the new "send again" button is
capped at 60 sends per file per hour when the cap protecting any single recipient is 5 — so a stuck
click, or a bad actor with an account, can put 60 copies of one email into one inbox, out of the
same sending domain your whole product's deliverability depends on. Also one small fix. Separately,
your test-count and summary documents have fallen a pass behind again, and — the one worth your
attention — the automated check that stops the "we have made zero live calls" ledger from going
stale is turned off in CI while two documents state that it is enforcing. That check works; I
tested it. It is one line to switch back on, and it is the guarantee everything else in this
project's honesty rests on.

**What only the live spikes can settle** is unchanged from last pass, with one addition. No line of
code can tell you what Mailgun actually puts in a real inbound payload, whether Zoho's link API
returns an embed token in the shape we guessed, or where Google's real share ceiling sits — those
are still four spikes with a runbook. The addition: now that each tenant gets its own folder, the
spikes should also answer what these providers do when we ask for a folder whose name already
exists, because the code assumes it can create one per tenant and currently forgets which one it
made every time the process restarts.

---

# Fifth pass verdict — Critic, 2026-09-10 — against HEAD `d6031ac`

**Scope, as tasked:** re-run my own R-1 and R-2 reproductions against HEAD; verify the in-flight
guard is a database constraint rather than a read-then-insert; verify tenant folder ids persist and
survive a restart; verify CI's ledger step no longer carries `continue-on-error`; verify the
founder-facing counts match reality. Everything else in the per-AC table is **carried forward from
the fourth pass, not re-probed**, except AC-U4, which fix passes 8 and 9 touched directly and which
I re-probed end to end.

**Method:** `pnpm test` against real Postgres (388 passed / 7 live-gated skips / 69 files, zero
failures — matches the claim exactly). Built a **throwaway database at the genuine pre-0007 state**
(`critic_p1`: applied `0001`–`0006` only, by hand, seeded four rows, then applied `0007`) rather
than simulating the state on an already-migrated database. Wrote eight throwaway runtime probes
(CP-1..CP-8) covering the backfill's end-to-end consequence, 60 sequential resends at the DEFAULT
config, 12 concurrent clicks, cross-file resends by one requester, a simulated process restart's
folder resolution, the `days`-mode settings round-trip, unbounded audit growth, and non-UUID path
ids. Read migrations `0007`/`0008`, `RateLimitService`, `AuditService.resendDelivery`,
`deliveries.insertQueuedIfNotInFlight`, `FilesService.resolveTenantFolder`, both real adapters'
`ensureFolder`/`resolveFolder`, and `queue.ts`'s dead-letter hook. All probes and the throwaway
database deleted; `src/**` untouched; nothing committed; working tree clean.

### Verdict: **SHIP-READY-FOR-LIVE-SPIKES**

R-1 and R-2 are genuinely, verifiably closed — not papered over, and closed with the right
mechanisms (a follow-up migration with a guarded `UPDATE`; a real partial *unique* index that makes
the database decide the race). The three minors I named are closed too. The live spikes are
credentialed probes of Zoho/Drive/Mailgun and nothing I found this pass touches that path, so the
gate they are waiting on is open.

But I did find one **new serious defect (N-11)**, and it is in the same class as R-1 and hits the
same acceptance criterion: **renaming a file silently extends its expiry.** It is pre-existing, not
a regression of these fix passes, and it affects *every* file rather than only pre-migration ones —
because `days` is the mode every new file is created in. It does not block the spikes; it must be
fixed before a customer's hand is on the settings form.

---

### R-1 — **CLOSED, verified on a genuine pre-0007 database**

I did not trust an already-migrated database for this. I created `critic_p1`, applied migrations
`0001`–`0006` and nothing else, seeded the four row shapes that matter, then applied `0007`:

```
--- before 0007 ---                       --- after 0007 ---
A|ready   |2026-10-10|none|               A|ready   |2026-10-10|custom|      <- backfilled, date intact
B|ready   |          |none|               B|ready   |          |none|        <- honestly 'none', untouched
C|ready   |2026-11-01|days|30             C|ready   |2026-11-01|days|30      <- post-0006 row, untouched
D|expired |2026-01-01|none|               D|expired |2026-01-01|custom|      <- harmless
self-contradictory rows remaining: 0
```

Every property I asked for holds: the exact stored date is preserved (`'custom'` is a pass-through,
never re-derived), the `AND expiry_mode = 'none'` guard leaves an already-edited post-0006 row
alone, and a genuinely no-expiry row is not invented an expiry. **Zero** rows remain in the
self-contradictory `expires_at IS NOT NULL AND expiry_mode = 'none'` state that was the whole
finding.

The end-to-end consequence is closed too (probe CP-1, on a row in exactly the backfilled state):

```
CP-1 radios: custom=true  none=false        (the page no longer lies about the file)
CP-1 save status=302 -> expires_at = 2026-10-10T00:00:00.000Z, mode=custom   (was: null)
```

The fourth pass's reproduction — *"save the form for any other reason, expiry becomes `NULL`"* — no
longer reproduces. One honest sub-note, below the bar for a finding: the `custom` field is
date-granularity, so a save round-trips a `12:00Z` expiry down to `00:00Z`. That is ≤24h in the
**stricter** direction, which `docs/research/03` permits, and it is a property of the date input,
not of the backfill.

### R-2 — **CLOSED, both halves, verified independently**

**The in-flight guard is a database constraint, not a read-then-insert.** Confirmed directly
against Postgres:

```
SELECT indisunique FROM pg_index ... WHERE relname='deliveries_resend_in_flight_idx';  -> t
CREATE UNIQUE INDEX deliveries_resend_in_flight_idx ON public.deliveries USING btree
  (file_id, requester_address)
  WHERE ((reason ~~ 'resend_of:%') AND (outcome = ANY (ARRAY['queued','sending','dispatching','granted'])))
```

`deliveries.insertQueuedIfNotInFlight` is a single `INSERT ... ON CONFLICT (file_id,
requester_address) WHERE <that exact predicate> DO NOTHING RETURNING *` — there is no `SELECT`
before it and no application-side decision in the race. My own independent 12-concurrent-click
probe (CP-3), fired as one `Promise.all` so all twelve are genuinely in flight together:

```
CP-3 codes = [302,409,409,409,409,409,409,409,409,409,409,409]
CP-3 deliveries rows = 2 (original + exactly one resend)   mails = 1
```

I also checked the guard *releases*: `sent`/`failed`/`unconfirmed` all fall outside the index
predicate, `granted` is genuinely non-terminal (migration `0004`) and correctly inside it, and a
resend job that exhausts `JOB_MAX_ATTEMPTS` is driven to `failed` by `runDeadLetterHook`
(`src/jobs/queue.ts`) — so a dead job cannot leave a `(file, requester)` pair permanently
un-resendable. That was the failure mode I most expected from a guard of this shape, and it is
handled.

**The amplification is gone.** The fourth pass's exact reproduction, re-run at the **default**
config (probe CP-2, 60 sequential clicks, each one's job drained so the in-flight guard cannot mask
the rate gate):

```
CP-2 caps: {requester:5, file:60, tenant:300, domain:30}
CP-2 accepted=5  rate_limited(429)=55  in_flight(409)=0
CP-2 MAILS TO ONE ADDRESS = 5     (was: 60)
```

Five, not sixty — the shared per-recipient ceiling, exactly the identity the cap exists to protect.
And the bucket is genuinely shared across a sender's files, which was the other half of the
finding (probe CP-4, one requester, two files, alternating clicks at the default config):

```
CP-4 codes = [302,302,302,302,302,429,429,429,429,429,429,429]
CP-4 mails to one address across two files = 5
```

`checkResend` delegating to `checkInboundRequest` — the same function the webhook path calls — is
the right shape: one implementation, so the two paths cannot drift apart, and the `tenant` bucket
(never consulted at all before) is now in the path. I looked for a way around it and did not find
one: the `requester` bucket key is the F-8-normalized address, so `+tag` and Gmail-dot variants of
one recipient share the cap, and a second `failed` row for the same pair collides on the same
index and the same bucket.

### Minors from the fourth pass — all three closed

- **R-3, folder identity across restarts — CLOSED, and better than I asked for.** I asked for
  persistence; the fix shipped persistence **plus** lookup-by-name **plus** an advisory lock —
  three independent defences. Probe CP-5 simulates a restart (a brand-new container, therefore
  brand-new adapters with empty caches) and publishes a second file for the same tenant:

  ```
  CP-5 persisted after first publish:  zoho=zoho-folder-20  drive=drive-folder-1
  CP-5 after restart-publish:          zoho=zoho-folder-20  drive=drive-folder-1
  CP-5 restarted process's folder map: [[<tenantId>, "zoho-folder-20"]] / [[<tenantId>, "drive-folder-1"]]
  ```

  No fresh id was minted; the restarted process primed its cache from `tenants.zoho_folder_id` /
  `drive_folder_id`. I also traced every call site of `ensureFolder` to confirm none of them can
  reach the adapter unprimed — `SharingEngine.provision` uses `driveShare.copy`, which never
  touches a folder, and `uploadResumable`'s internal `ensureFolder` is always preceded by
  `resolveTenantFolder`. Both real adapters now `findFolderByName` before creating, so even a wiped
  `tenants` row adopts the existing folder rather than forking storage.
- **CI ledger check — CLOSED.** `continue-on-error` is gone from the entire workflow file; the only
  surviving occurrence of the string is inside a comment. I re-verified the generator has real
  teeth (`pnpm gen:ledger -- --check` → exit 0 on a clean tree; the fourth pass proved it exits 1
  on drift), so the README's and the ledger's own claim that CI enforces this is now true.
- **Stale counts — CLOSED.** Every founder-facing number matches what I measured:
  `README.md:18` "388 tests pass (+1 browser e2e)"; `docs/founder-summary.md:4` "38 commits · 388
  tests + 1 browser e2e" (`git rev-list --count HEAD` = **38**); `docs/progress.md:47` "388 tests +
  1 e2e green, 7 live-gated skips; ledger 0 verified-live / **18** unverified-live";
  `docs/verification-ledger.md:5` "0 verified-live, **18** unverified-live". `pnpm test` reported
  **388 passed | 7 skipped**. Four documents, four independent claims, all true.

---

### N-11 (serious; **new this pass**; pre-existing, not a regression of fix pass 8/9) — renaming a file silently **extends** its expiry

`SettingsService.resolveExpiry('days', ...)` returns `clock.now() + days` — recomputed from *now*,
never anchored to the file's creation. `updateSettings` recomputes it on every save where
`expiryMode` is present, and `src/views/file-detail.eta:151-152` pre-fills the `days` radio and the
day count from the persisted row, so the settings form **always** submits them. Every file is
created in `days` mode (`createStaged` seeds `DEFAULT_EXPIRY_DAYS`), so this is not an edge case —
it is the default path for every file in the product.

Reproduced (probe CP-6: one file, 25 days of virtual time pass, then the sender renames it and
changes nothing else, submitting exactly what the page pre-filled):

```
CP-6 at creation:         mode=days days=30  expires_at = Sat Oct 10 2026
CP-6 page pre-fills:      daysRadioChecked=true  expiryDays=30
CP-6 save status=302
CP-6 expires_at AFTER rename = Wed Nov 04 2026
CP-6 expiry moved by 25 DAYS (positive = file lives LONGER)
```

A file with five days left now has thirty. The sender did not touch the expiry control, was shown
no expiry *date* anywhere on the page (the template renders only the day count, never the resulting
date, so there is no visual signal that anything moved), and no record was written. This is a
consent/safety invariant moving in the **looser** direction with no user intent — the identical
harm R-1 described, arrived at by extension rather than deletion, and `docs/research/03` forbids it
in the same words.

Severity relative to R-1: lower, because the file still expires — the harm is bounded by the file's
own age rather than being unbounded permanence. Higher in reach: R-1 could only fire on rows
predating migration `0006`; this fires on every file in every database, forever. There is a sharp
irony worth naming: because the R-1 backfill wrote `'custom'`, and `'custom'` is a pure
pass-through, **files old enough to have been backfilled are now safer against this than files
created today.**

**Do this.** Only recompute `expires_at` when the sender actually changed something about the
expiry — if `input.expiryMode === 'days'` and `input.expiryDays === file.expiry_days` and the file
already has an `expires_at`, keep the stored timestamp untouched. (Anchoring on a stored
`expiry_anchor` column is the more general fix, but it needs a migration and a backfill for a
property the two existing columns already determine; the equality check is smaller and reversible.)
Pin it with a test that advances the clock, saves the form with only `displayName` changed, and
asserts `expires_at` is byte-identical. And render the resulting date next to the day count, so the
control cannot change a value the page never showed.

### N-12 (minor; new) — a rate-limited resend writes one unbounded `deliveries` row per click

`AuditService.resendDelivery` writes a `rate_limited` audit row on every refused click, with no
aggregation. Probe CP-7, 200 clicks against a cap of 1:

```
CP-7 200 clicks at cap 1 -> deliveries rows = 201, rate_limited rows = 199
```

At the default config, CP-2's 60 clicks produced 61 rows of which 55 were `rate_limited` noise.
This is the exact phenomenon F-7's suppression aggregate was built to bound on the inbound path
(one row at `cap + 1`, not one per event) — the new path did not inherit it. It is only *minor*
because the traffic is authenticated, CSRF-protected and confined to the tenant's own data, so it
is self-inflicted noise rather than an attack surface. But it degrades AC-A2's feed, which is the
sender's primary signal, precisely when something is going wrong. **Do this:** reuse
`incrementSuppressed`'s shape, or write at most one `rate_limited` row per (file, requester, hour).

### N-13 (minor; new) — a persisted folder id has no self-heal, and the comment above the CI step is now false

Two small ones from the same fix passes:

- `primeFolder` trusts `tenants.zoho_folder_id` unconditionally. If that folder is later trashed or
  moved provider-side, every upload for that tenant targets a dead id forever — the lookup-by-name
  fallback is unreachable because the cache hit short-circuits it. Pre-fix, `ensureFolder` would
  have healed by re-creating. Bounded (uploads fail loudly rather than silently mis-filing) and
  provider behaviour here is `@unverified-live`, so: add one line to spike 1's record-list — *"trash
  the tenant folder, then upload: what does the API return for a dead `parent_id`?"* — and clear the
  persisted id on that error class.
- `.github/workflows/ci.yml:85-89` still carries the comment *"placeholder today — it only prints
  'not implemented' and always exits 0 … drop `continue-on-error` here"*, above a step that has
  neither property any more. The fix pass deleted the flag and left the comment that justified it.
  This is the fifth consecutive pass in which a document describes a mechanism that the code no
  longer implements, and it is now inside the very file the mechanism lives in. One-line deletion.

### R-5 (minor; **still open**, carried) — non-UUID path ids still 500

Unchanged from the fourth pass; re-probed at HEAD (CP-8):

```
GET /files/not-a-uuid = 500   GET /api/files/not-a-uuid/deliveries = 500   POST .../resend = 500
```

A Postgres `22P02` still escapes as an unhandled error, still contradicting the "a wrong tenant gets
a plain 404, never a distinguishing detail" contract in `src/http/routes/files.ts:49-51`. One shared
UUID format check in the route schema turns all of them into 404s.

### R-4 residuals (minor; carried) — no ADR for the resend action

`docs/decisions.md` is still at 20 ADRs with no entry for the resend action. A user-visible surface
that sends mail, now carrying two non-obvious constraints — an eligibility whitelist and a partial
unique index that decides a concurrency race — belongs where an architect will look for it. Fix
pass 9's reasoning is excellent, but it lives only in a migration comment and a review report.

### Housekeeping — closed

The five untracked `*.probe.test.ts` files the fourth pass flagged are gone: `git status` is clean,
and every file in `tests/review/` is tracked and running. My own eight probes and the `critic_p1`
database are deleted.

---

### Per-AC verdict (against HEAD `d6031ac`)

| AC | Fourth pass | Now | Note |
|---|---|---|---|
| **AC-U1** three artifacts | MET | **MET** | carried |
| **AC-U2** flag OFF → raw Zoho link | MET with caveat | **MET with caveat** | carried; spike 1 |
| **AC-U3** flag ON → branded page | MET with caveat (minor) | **MET with caveat (minor)** | carried; spike 4 |
| **AC-U4** expiry enforced | **REGRESSED — NOT MET** for pre-0006 files | **MET with caveat — recovered, new caveat** | R-1 closed: verified on a genuine pre-0007 database, zero self-contradictory rows, backfilled row renders and saves correctly. New caveat **N-11**: a save on a `days`-mode file re-issues `expires_at` from now, extending it — a looser-direction change with no user intent, on every file. Enforcement machinery (sweep, job, `/readyz.strandedExpiries`) untouched and still sound. |
| **AC-R1** DMARC-fail/absent → no delivery | unchanged, carried | **unchanged — carried, not re-probed** | C′/N-10 still gated on spike 3c |
| **AC-R2** file chosen only from the token | MET | **MET** | carried |
| **AC-R3** delivery to the verified From only | MET with caveat | **MET with caveat** | carried; resend still can only target the original row's own `requester_address` |
| **AC-R4** ≤20 MB attach / larger Drive share | MET with caveat | **MET with caveat** | carried; per-tenant folder identity now survives restarts (R-3 closed, CP-5) |
| **AC-R5** custom message + display name | MET | **MET** | carried |
| **AC-R6** signature required | MET | **MET** | carried |
| **AC-E1** auto-duplicate at the cap | MET with caveat | **MET with caveat** | carried; `SharingEngine` untouched again this pass |
| **AC-E2** idempotent, serialized per (tenant, file) | MET | **MET** | carried |
| **AC-A1** file-scoped access only | MET | **MET** | carried |
| **AC-A2** every delivery audit-logged | MET | **MET with caveat (minor)** | rows are all there and the abuse bound is now correct; **N-12** is a noise bound, not a gap — a refused resend writes one unbounded row per click where the inbound path aggregates |
| **AC-A3** tenant isolation | MET | **MET** | carried; the resend route's cross-tenant/cross-file 404s were re-probed in the fourth pass and nothing since touched that lookup |

### What is genuinely good in these fix passes

- **Both fixes chose the mechanism that cannot be raced, over the mechanism that is easier to
  write.** A partial *unique* index with `ON CONFLICT DO NOTHING RETURNING` instead of a
  read-then-insert; an advisory lock with a re-read *inside* the lock for folder resolution. Twelve
  concurrent clicks producing exactly one mail is not a test that passed by luck.
- **`checkResend` calls `checkInboundRequest` rather than re-implementing it.** The obvious fix was
  to copy the four bucket checks into the resend path. Sharing the function means the two paths
  cannot drift, which is the failure mode that produced R-2 in the first place.
- **The R-1 fix shipped as `0007`, not as an edit to `0006`.** An already-applied migration does not
  re-run; editing it would have looked correct in code review and fixed nothing on any existing
  database. The `AND expiry_mode = 'none'` guard makes it safe to run after a file has already been
  edited post-0006.
- **The R-3 fix over-delivered.** Persistence, lookup-by-name, and a lock — three independent
  defences where I asked for one. The migration comments explain *why* each exists, not what it does.
- **The honesty infrastructure now has teeth and the documents that promise it are true.** Four
  founder-facing counts, four independent measurements, four matches. That is rarer than it sounds.

### Lessons filed

One, appended to `docs/lessons.md` (2026-09-10): the N-11 rule — a control whose stored value is
*derived from the moment it was set* must be re-derived only when the input actually changed, and a
form must never submit a control the page did not show the current value of.

---

### Plain language, for the founder

Both problems I flagged last time are genuinely fixed, and I checked them the hard way — I rebuilt a
database at the exact old state to prove the expiry repair works on files that already exist, and I
fired twelve simultaneous clicks at the "send again" button and got exactly one email out, with the
per-recipient cap now holding at five an hour instead of sixty. Your test count, commit count and
"nothing has touched a live provider yet" ledger are all accurate in every document I checked, and
the CI check that guards them is switched on again — so you can go run the live spikes.

One new thing, which I found while re-testing the expiry fix and which has been there all along:
renaming a file quietly gives it a fresh 30 days. A file with five days of life left goes back to
thirty because the settings page re-submits "expires in 30 days" as if you had just typed it, and
the page never shows you the actual date, so nothing on screen tells you it moved. Expiry is a
promise to the person you sent the file to, and this makes that promise longer without you asking —
so it needs the same small fix R-1 got before a customer touches that form, though it does not hold
up the live spikes at all.


---

## Fix pass 10 status (orchestrator, 2026-09-10) — response to the fifth pass

- **N-11 — fixed.** `SettingsService.updateSettings` decides inside the transaction, against the
  stored row: same mode (`days`), same day count, expiry already set ⇒ `expires_at` is left
  byte-identical; any actual change to the control (mode or count) applies the freshly resolved
  value. The per-file page now renders the resulting date next to the day count. Test:
  `tests/review/fix-pass-10.test.ts` (25 virtual days, rename only ⇒ identical timestamp; change
  the count ⇒ re-issued).
- **N-12 — fixed.** Refused resends upsert one aggregated `rate_limited` row per (file,
  requester, hour) with `suppressed_count` (migration 0009, partial unique index), mirroring F-7.
  Test: 30 refused clicks ⇒ 1 row.
- **R-5 — fixed.** `requireUuidParams` preHandler on every `:id`/`:deliveryId` route (HTML and
  JSON) returns the same 404 a foreign tenant's id gets. Test: six routes.
- **N-13 — fixed.** `forgetFolder` on both ports; a `NotFoundError` from an upload clears the
  cached and persisted folder id and rethrows so the retry re-creates it; the stale CI comment is
  gone; spike 1 now records what a dead `parent_id` returns. Test: dead-folder round trip.
- **R-4 residual — fixed.** ADR 21 documents the resend action.

---

## Sixth pass — 2026-09-10 (Critic)

**Verdict: SHIP-READY-FOR-LIVE-SPIKES.** No fatal issues, no serious issues. Every finding
from the fifth pass (N-11, N-12, N-13, R-5, R-4-residual) is closed, and each was re-proven
by a fresh adversarial probe rather than by reading the fix pass's own test. Three new
findings, all **Minor**; none blocks the live spikes and none is a safety regression.

Scope of this pass: re-run CP-6/CP-7/CP-8 and the dead-folder self-heal against HEAD, plus
the edge cases the N-11 fix could plausibly have missed. Probes were throwaway
(`tests/review/zz-critic-probe{6,7,8}.test.ts`), run against a real Postgres, and deleted;
no `src/**` file was touched. Full suite re-run at the end: **392 passed / 7 skipped / 70
files**, e2e **1 passed** — the founder-facing ledger is accurate.

### N-11 — CLOSED (was serious)

Re-run of CP-6 the hard way: through the **real settings route**, submitting the values
**scraped out of the actually-rendered form**, not values a test author chose.

- File starts `expiry_mode=days`, `expiry_days=30`, `expires_at=2026-10-10T06:08:53.009Z`.
- Clock advances **25 virtual days**.
- The rendered form yields exactly
  `{displayName:"doc.pdf", expiryMode:"days", expiryDays:"30", expiresAt:"2026-10-10", customMessage:"", allowlist:""}`
  — i.e. the form still re-submits the pre-filled control, which was the mechanism of the bug.
- Only `displayName` is changed; `POST /files/:id/settings` → 302.
- After: `renamed-via-route.pdf`, `days`, `30`, **`expires_at = 2026-10-10T06:08:53.009Z`** —
  byte-identical. The 25 days were not given back.

The fix is in the right place: the decision is made *inside the transaction against the
stored row* (`SettingsService.updateSettings`), not in the route and not against the
request's clock, so it holds for the JSON path and any future caller too.

Edge cases probed, all correct:

| Case | Expected | Observed |
|---|---|---|
| `none` → `days` on a file with **no** expiry | apply `now + N` | applied exactly |
| `custom` → `days` | apply `now + N` | applied exactly |
| day count changed (30 → 10, 7 → 8) | apply `now + N` | applied exactly |
| same count re-submitted after 5 more days | frozen | frozen |

**The rendered date now matches the stored value.** The probe asserted it rather than
eyeballing it: the `data-expiry-date` span next to the day count read `2026-10-10`, equal to
`expires_at`'s own UTC date. That was the second half of the fifth-pass lesson (a form must
not submit a control whose effective value the page never showed), and it is genuinely done.

### N-12 — CLOSED (was minor)

CP-7 at 200 clicks, `RATE_REQUESTER_PER_HOUR=1`:

- 200 calls → `ok: 1`, `rate_limited: 199`.
- Delivery rows for the file: **3** — the original `failed`, the one accepted `queued`
  resend, one `rate_limited` aggregate with `suppressed_count = 199`.
- 50 more clicks later: still **3** rows, `suppressed_count = 249`. Accounting is exact:
  249 suppressed + 1 accepted = 250 clicks, nothing lost, nothing double-counted.

Honest limit of this probe: the hour-boundary half is **inconclusive under the fake clock** —
`rate_limit_counters` and `deliveries.created_at` both use Postgres `now()`, which
`FakeClock.advance()` cannot move, so my "next hour" clicks landed in the same real hour. The
bound is nonetheless correct *by construction*: the partial unique index keys on
`date_trunc('hour', created_at AT TIME ZONE 'UTC')`, so the worst case is one row per (file,
requester, hour) — 24 rows/day for a requester hammering continuously, versus the unbounded
row-per-click it replaced. `created_at` staying at the hour's first refusal while
`completed_at` advances is the right shape for an hourly aggregate.

### R-5 — CLOSED (was minor)

CP-8 widened: **12 malformed id shapes × 6 tenant-scoped routes = 72 requests**
(`not-a-uuid`, empty, `..`, `%2e%2e%2f`, a SQL-injection string, a truncated UUID, a
UUID-with-`zz`, 4 KB of `x`, the nil UUID, `%00`, `null`, a JNDI lookup string).

- Status histogram: `404 × 64`, `414 × 6`, `302 × 1`, `200 × 1`. **Zero 5xx.**
- The `414`s are the 4 KB path hitting Fastify's URL cap — refused before routing, correct.
- The `302` is `GET /files/..` → `/files`, the router's own path normalization to a
  session-protected page. `/files/../settings`, `/api/files/../status` and
  `/files/%2e%2e/delete` all 404. No traversal, no privilege gain.
- **Indistinguishability holds byte-for-byte**: `GET /files/not-a-uuid` and `GET
  /files/<another tenant's real file id>` return identical status *and* identical body; the
  JSON pair are both `{"error":"not_found"}`. A malformed id is not an oracle.
- The tenant's own file still renders 200 and is unmodified afterwards.

The remaining `200` is new finding **N-15**, below.

### N-13 — CLOSED (was minor)

Dead-folder self-heal, re-run independently on **both** ports (the fix-pass-10 test only
covers Zoho):

| Arm | Persisted before | After one `NotFoundError` | After retry |
|---|---|---|---|
| Zoho | `zoho-folder-13` | `zoho_folder_id = NULL`, `drive_folder_id` **untouched** | `zoho-folder-17`, file `ready` |
| Drive | `drive-folder-1` | `drive_folder_id = NULL`, `zoho_folder_id` **untouched** | re-created, file `ready` |

No collateral clearing of the sibling port's id, and exactly **1** `drive_copies` row for the
file afterwards — the heal does not orphan a copy. I also checked the third place a dead
folder could bite: `SharingEngine.provision`'s duplicate path calls `driveShare.copy()`, which
sets no `parents` (the copy inherits the source's folder), so it has no tenant-folder
dependency to heal. N-13's two call sites are complete coverage, not two of three.

### R-4 residual — CLOSED

ADR 21 documents the resend action. Nothing further to attack here.

### New findings (all Minor)

**N-14 — a `custom`-mode expiry loses its time-of-day on any settings save.**
The N-11 fix is asymmetric: it freezes `days` mode but leaves `custom` mode re-derived on
every submit. The page renders `expires_at.toISOString().slice(0,10)` into a `type="date"`
input, and the route parses it back with `new Date("YYYY-MM-DD")` — UTC midnight. Measured on
a real round trip: `2026-10-20T06:08:53.364Z` → `2026-10-20T00:00:00.000Z`, **delta
−22,133,364 ms**. Direction is provably always ≤ (truncation to the stored value's own UTC
day), so it can only *shorten* an expiry, never extend one — it does not violate the
"stricter only" rule and it is idempotent after the first save. Blast radius: rows that are in
`custom` mode *and* carry a nonzero time-of-day, which is exactly the set migration 0007
backfills — i.e. any database created between 0006 and 0007. On a fresh deploy the set is
empty, because a sender-chosen custom date is already stored at UTC midnight. Fix is the same
shape as N-11's: keep the stored timestamp when the submitted date equals the stored value's
UTC date. Worth doing before a customer edits a backfilled file; not worth holding the spikes.

**N-15 — `GET /api/files/:id/deliveries` never establishes file ownership.**
Unlike its sibling `/status`, the poll endpoint does not look the file up; it goes straight to
the tenant-scoped delivery query. Measured: own file, another tenant's file, and the nil UUID
all return `200 {"items":[],"total":0}` — identical, so there is **no oracle and no leak
today**, and the polling island still learns about deletion from `/status` (which correctly
returns `{"status":"deleted"}`). The risk is forward-looking: the ownership check is the
invariant that makes this payload safe, and it currently lives only in the repository query.
The day someone adds a field to this response that is not tenant-scoped, the missing check
becomes the leak. One `files.findById` → 404 makes it structural instead of incidental.

**N-16 — nothing at the database level pairs `expiry_mode='days'` with a non-null
`expiry_days`.** I probed the state the N-11 guard depends on: with `expiry_days` forced to
`NULL` while `expiry_mode='days'`, a rename **extends the expiry again** (`2026-09-23` →
`2026-10-02`), because `current.expiry_days === days` is false and the guard falls through to
"apply the fresh value". A query of `pg_constraint` returns **no** CHECK mentioning
`expiry_days`. The state is unreachable through current code (`createStaged` writes both
columns; `updateSettings` coalesces to `DEFAULT_EXPIRY_DAYS`), so this is latent, not live —
but N-11 was *itself* a bug in this exact column pair, and the fix's correctness now rests on
a convention rather than a constraint. `CHECK (expiry_mode <> 'days' OR expiry_days IS NOT
NULL)` in the next migration turns the convention into an invariant, and matches how 0006/0007
already treat this pair.

### What is genuinely good in this pass

- **The N-11 fix was made where it cannot be bypassed.** Deciding inside the transaction,
  against the row that is about to be written, means the guard holds for the HTML route, the
  service, and any caller not yet written. The easy version — comparing in the route handler —
  would have passed the same test and protected one path.
- **Rendering the resulting date was not skipped.** It was the softer half of the lesson, the
  half with no test forcing it, and it is the half that would let a future regression go
  unnoticed. It shipped anyway.
- **`forgetFolder` landed on both ports symmetrically**, and clearing one port's id provably
  does not disturb the other's. A one-port fix would have looked complete in review.
- **R-5's 404s are byte-identical to the foreign-tenant 404s.** Returning "404" is easy;
  returning the *same* 404 is the part that actually denies the oracle, and it was done.
- **The ledger is still true.** 392 + 7 skipped + 1 e2e, measured independently, matches every
  document that claims it. Six passes in, that has never once drifted.

### Lesson filed

One, appended to `docs/lessons.md` (2026-09-10): when a fix freezes a derived value for one
mode of a control, check every *other* mode of the same control in the same pass — and back
the invariant the fix now depends on with a database constraint, not a convention.

---

### Plain language, for the founder

The expiry bug is genuinely fixed, and I checked it the way a user would hit it: I loaded the
real settings page, took the exact values the page had filled in, waited twenty-five virtual
days, changed only the file's name, and saved. The expiry date did not move by a millisecond —
and the page now prints the actual date next to "30 days", so nothing can change silently
again. I also fired 200 rapid "send again" clicks and got one email, three log rows and an
exact count of the refusals; threw twelve kinds of malformed link at all six pages and got
zero crashes and a 404 indistinguishable from someone else's file; and killed the storage
folder on both providers to confirm the system notices and rebuilds it. Nothing here holds up
the live spikes — go run them.


---

## Fix pass 11 status (orchestrator, 2026-09-10) — response to the sixth pass

- **N-14 — fixed.** `updateSettings` applies the same unchanged-control rule to `custom` mode:
  when the submitted calendar date equals the stored timestamp's UTC date, the stored value is
  kept; a different date is applied. Test: `tests/review/fix-pass-11.test.ts`.
- **N-15 — fixed.** `GET /api/files/:id/deliveries` establishes ownership via `files.getById`
  before listing; foreign or unknown ids are a 404, identical to `/status`. Test: own / foreign /
  nil UUID.
- **N-16 — fixed.** Migration 0010 normalizes any stray rows and adds
  `CHECK ((expiry_mode = 'days') = (expiry_days IS NOT NULL AND expiry_days > 0))`. Test: both
  directions of the pairing are refused with `23514`.

Suite after fix pass 11: 395 tests + 1 e2e, 7 live-gated skips, zero `it.fails`.
