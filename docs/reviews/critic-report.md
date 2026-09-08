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
