# Integration Architecture — Validating the "Platform-Owned Domain + Central File Store" Model

**Stage:** Discovery feasibility (research + design only — no code, no locked stack).
**Author:** software-architect.
**Validates:** the founder's latest direction (2026-09-07), which *supersedes* the
per-customer Google-OAuth assumption still present in `04-refined-problem-model.md §Auto-join`.
**Inputs:** `00-discovery-synthesis.md`, `04-refined-problem-model.md`, `03-security-privacy-risks.md`.

> **What changed since `04`.** `04` still had each customer *connecting their own Google
> account (OAuth)* so we watch *their* mailbox. The refined model removes that entirely:
> **the platform owns one domain, provisions a dedicated inbound address per customer on it,
> and monitors its *own* mailboxes.** Files live in the *platform's own* Google Drive + Zoho
> WorkDrive accounts. This doc validates *that* model. Where the two disagree, this doc wins.

---

## 0. Does it hang together? (verdict up front)

**Yes — and it is materially simpler and safer than the OAuth model.** Every load-bearing
piece maps to a proven, boring primitive: catch-all inbound mail on an owned domain, inbound
authentication results the mail layer already computes, a first-party Drive/WorkDrive account
the platform controls, and a subscriber list that lives in *our* database. The one genuinely
novel mechanic — auto-duplicating a Drive file when it approaches the share cap — is a small,
well-bounded component (§7). The open questions that remain (§8) are calibration and
provider-choice questions, not "does the shape work" questions.

The single biggest thing this model buys: **it deletes per-customer Google OAuth, and with it
the CASA audit regime and the full-inbox breach blast radius** (§2). That is the expensive,
hard-to-reverse decision this stage exists to get right, and the refined model gets it right.

---

## 1. End-to-end component diagram

```
                                  ┌──────────────────────────────────────────────┐
                                  │      PLATFORM-OWNED DOMAIN (one domain)        │
                                  │   MX → inbound mail gateway (catch-all)        │
                                  │   cust-<id>@domain , cust-<id>+<token>@domain  │
                                  └───────────────────────┬──────────────────────┘
      subscriber / file-requester                         │  raw inbound message
        emails the customer's                             │  (+ provider auth-results:
        dedicated address                                 ▼   SPF / DKIM / DMARC)
   ┌───────────────┐                       ┌──────────────────────────────────┐
   │ end recipient │──────────────────────▶│  INBOUND PIPELINE  (per message)  │
   │ (subscriber / │                       │                                   │
   │  requester)   │◀───┐                  │  1. TENANT RESOLVE                 │
   └───────────────┘    │                  │     local-part → customer id      │
          ▲             │ confirm / reply  │  2. AUTH GATE                      │
          │             │ / file delivery  │     require DMARC pass; else →     │
          │             │                  │     quarantine / manual queue     │
          │             │                  │  3. RATE / ANOMALY GATE            │
          │             │                  │     per sender · per cust · per file
          │             │                  │  4. INTENT CLASSIFY                │
          │             │                  │     subscribe │ file-request │ other
          │             │                  └───────┬───────────────┬───────────┘
          │             │                          │               │
          │             │            ┌─────────────▼──┐     ┌──────▼──────────────────┐
          │             │            │ SUBSCRIBE ACTION│     │ FILE-REQUEST ACTION     │
          │             │            │ double opt-in:  │     │ resolve file by token/  │
          │             │            │ write PENDING → │     │ allowlist (never body)  │
          │             │            │ send confirm →  │     │ → SHARING ENGINE (§7)   │
          │             │            │ activate on click│    │ → reply w/ link/attach  │
          │             │            └────────┬────────┘     └──────┬──────────────────┘
          │             │                     │                     │
          │             └─────────────────────┴─────────────────────┘  (outbound replies
          │                                                              go via SENDER, below)
          │
          │                          ┌──────────────────────────────────────────────┐
          │   broadcast lands  ◀─────│  OUTBOUND / BROADCAST PATH                     │
          │   in inbox               │  compose → segment (this tenant's list only)  │
          │                          │  → SENDER (owner Gmail ≤500/day  OR  ESP on    │
          │                          │    platform domain, post-MVP) → per-tenant log │
          │                          └───────────────────────▲──────────────────────┘
          │                                                   │
   ┌──────┴───────────────────────────────────────────────┐  │  reads list + templates
   │  PLATFORM DATA STORE  (multi-tenant, our DB)          │◀─┘
   │  ┌────────────┐ ┌────────────┐ ┌───────────────────┐  │
   │  │ tenants    │ │ subscribers│ │ files + share_map │  │  ← the customer's subscriber
   │  │ (customer) │ │ (per tenant│ │ (file ↔ Drive/Zoho│  │    list lives HERE, in OUR
   │  │  + inbound │ │  consent   │ │  ids, share counts│  │    system — NOT in the
   │  │  address)  │ │  log)      │ │  , duplicate copies)│ │    customer's Google.
   │  └────────────┘ └────────────┘ └───────────────────┘  │
   │  ┌────────────────────────────────────────────────┐  │
   │  │ audit_log (every share/consent decision)        │  │
   │  └────────────────────────────────────────────────┘  │
   └───────────────────────────────┬───────────────────────┘
                                    │ file operations (first-party creds)
                    ┌───────────────┴────────────────────────────┐
                    ▼                                             ▼
      ┌──────────────────────────────┐            ┌──────────────────────────────┐
      │ CENTRAL GOOGLE DRIVE ACCOUNT │            │ CENTRAL ZOHO WORKDRIVE ACCOUNT│
      │ (platform-owned, ONE account)│            │ (platform-owned, ONE account) │
      │ • private-share file→email   │            │ • create public external link │
      │   (email-only audience)      │            │   (filtered-internet audience)│
      │ • 600-share cap → SHARING    │            │   — the one public link type  │
      │   ENGINE auto-duplicates (§7)│            │     that passes NetFree        │
      └──────────────────────────────┘            └──────────────────────────────┘

   Small files (≤~20–25MB): SENDER attaches directly to the reply — no store needed.
```

**Reading the three delivery lanes** (from `04`):

| Audience | Delivery mechanism | Which central store |
|---|---|---|
| Email-only (Google services only) | **private Drive share to the requester's address** | Central Google Drive |
| Filtered-internet (NetFree/Rimon/Netspark) | **public external share link** | Central Zoho WorkDrive |
| Any, if file is small | **direct email attachment** | none (attached to reply) |

---

## 2. The big simplification: does this remove per-customer Google OAuth?

**Yes — completely, for the default product. Stated plainly:**

- **Inbound (subscribe + file-request):** we monitor **our own mailboxes on our own domain**.
  There is no customer mailbox to connect, so there is **no Gmail read scope, no
  `gmail.metadata`/`gmail.modify`, and therefore no Google restricted-scope verification and
  no annual CASA assessment** (the exact regime `03 §1` flagged as a go/no-go cost gate). The
  full-inbox breach blast radius — "a token-store dump exposes every connected owner's entire
  inbox" — **does not exist**, because we never hold a token to anyone's personal inbox.

- **File delivery:** files live in the **platform's own** Google Drive and Zoho WorkDrive
  accounts. Drive/WorkDrive API calls authenticate as **the platform's own single first-party
  account** (its own OAuth grant or a service account it owns), acting on *its own* data. This
  is categorically different from thousands of external users granting a published app
  restricted scopes on *their* Google data — which is what pulls an app into the CASA /
  external-verification regime. Acting on your own account is a first-party integration.
  *(Compliance nuance to confirm in the PRD with the advisor: Google's verification/CASA
  triggers are tied to restricted scopes requested from external users; a single self-owned
  account is normally outside that — but the exact Drive scope used and Google's current
  policy should be confirmed, not assumed. See `03` sources on restricted-scope verification.)*

- **The subscriber list is ours.** The customer's list lives in **our** multi-tenant DB
  (`subscribers` + `consent_log`), not in the customer's Google Contacts or a Google Sheet
  they own. Nothing about a customer's list depends on their Google account existing.

**The optional power path (post-MVP, opt-in — note it, don't build it):** a customer who
wants files delivered from **their own** Drive/brand, or a from-address on **their own**
domain, can connect their own Google account / domain. *That* path re-introduces per-customer
OAuth and, if it touches restricted Drive scopes at scale, the CASA question — which is
exactly why it is an opt-in upgrade tier the customer chooses, not the default everyone pays
for. **Default = zero customer OAuth. Power tier = customer's own OAuth, eyes open.**

---

## 3. Intent classification — "subscribe" vs "file request X" (options kept open)

The classifier runs *after* tenant-resolve and the auth/rate gates, so it only ever sees
authenticated, rate-limited mail for a known tenant. Three addressing conventions, best used
**layered** (most reliable first). Keep the final choice open for the PRD; the recommendation
is to make routing **deterministic where possible and fall back to content only as a last
resort**, because content parsing is the attacker-influenced surface (`03 §2.4`).

1. **Per-purpose sub-addressing (recommended primary).** Give each customer *structured*
   addresses, not one:
   - `cust-<id>+subscribe@domain` → unambiguously the subscribe intent.
   - `cust-<id>+file-<fileToken>@domain` → unambiguously "this specific file," where
     `<fileToken>` is an **opaque, non-guessable token** the platform minted and printed on
     the file's "request by email" button (the pre-filled `mailto:`). The file identity comes
     from *our* token map, **never from the email body** — this is the `03 §2.4` control
     (don't let body text choose the file) enforced structurally.
   This makes the common cases zero-guess: the local-part *is* the intent.

2. **Per-file `Reply-To` on outbound.** When we send a broadcast that advertises a file, the
   message's `Reply-To` is the `cust-<id>+file-<token>@` address. A recipient who just hits
   "reply" lands on the right intent with no subject convention to remember. Same token-map
   resolution.

3. **Subject/keyword conventions + light content classification (fallback only).** For mail
   sent to the bare `cust-<id>@domain` catch-all with no plus-token (a human typing the
   address fresh), fall back to subject/body cues ("subscribe", "add me", "הוסף אותי" /
   "שלח קובץ"). This is the *only* place free-text classification runs, and its output is
   **low-trust**: a file-request that resolves *only* from body text goes to the customer's
   **manual-approval queue**, never to auto-share. Subscribe-by-keyword is safe to auto-accept
   *into the pending/confirm flow* (not the active list) because double opt-in (§4) is the
   real gate anyway.

> Design stance: **identity of intent should come from the address, not the prose.** Plus-token
> addressing turns "what does this email want" from an NLP problem into a lookup. An LLM/regex
> classifier is a *fallback for un-tokenized mail*, not the primary path — which also keeps the
> attack surface small.

---

## 4. Anti-spoofing & consent controls — where they sit in the pipeline

All of these come straight from `03`; the refined model changes *where some of them live* but
not *that they are mandatory*. Mapped onto the §1 pipeline:

| Control (`03` ref) | Pipeline stage | Note under the refined model |
|---|---|---|
| **DMARC pass required on inbound** (`03 §2.1`) | Inbound step 2 (AUTH GATE) | Because MX is **ours**, our own mail layer computes `Authentication-Results`; we read it, we don't re-implement DNS. Fail/absent DMARC → quarantine, never auto-act. |
| **Double opt-in before any send** (`03 §3`) | SUBSCRIBE ACTION | "Auto-add" = auto-send-confirmation, write a `PENDING` row; activate to sendable **only on click**. Consent log is the same DB row. Load-bearing for Israeli spam law (₪1,000/msg). |
| **Owner allowlist + confirm for unknown requesters** (`03 §2.2–2.3`) | FILE-REQUEST ACTION | Requester on the tenant's allowlist (or a prior confirmed subscriber) → proceed. Unknown, even DMARC-clean → send a "click to receive" confirm, don't auto-deliver. |
| **File identity from token, not body** (`03 §2.4`) | INTENT CLASSIFY / FILE-REQUEST | Enforced by plus-token addressing (§3). Body text never selects a file for auto-share. |
| **Rate limits per sender / per customer / per file** (`03 §4`) | Inbound step 3 (RATE GATE) | Sits *before* classify so request-bombing is dropped cheaply; anomaly signal surfaces on the customer dashboard. |
| **Audit log every decision** (`03 §2.6`) | `audit_log` table | Sender, DMARC result, allowlist hit/miss, confirm status, file, tenant, timestamp. Answers "who has this file reached." |
| **Signed capability token, revocable delivery** (`03 §2.4, §7`) | SHARING ENGINE | Natural fit: the delivered artifact is a Drive private-share or a Zoho link — both are **revocable and not a permanent attachment**, satisfying the `03 §7` "don't ship a raw forever-attachment" control for anything above the small-file tier. |

**Net:** the AUTH GATE and RATE GATE are shared infrastructure at the front of the inbound
pipeline (they run once per message for every tenant); the CONSENT and ALLOWLIST controls live
inside the two action handlers. Nothing about moving to platform-owned mailboxes weakens any
control — and DMARC-on-inbound actually gets *easier* because we own the receiving MX.

---

## 5. Multi-tenancy shape — one domain + one file store, no cross-tenant leak

The whole product is one domain and (by default) one Google Drive + one Zoho account serving
many customers. The isolation is **logical, enforced in our application/data layer**, since the
external stores are single accounts. Four boundaries do the work:

1. **Address → tenant is the entry key.** Every inbound message resolves to exactly one
   `tenant_id` from its local-part (`cust-<id>...`). If it doesn't resolve, it's dropped. The
   `tenant_id` is then carried through the entire pipeline and stamped on every row and every
   action. There is no code path that acts without a resolved tenant.

2. **Every query is tenant-scoped.** `subscribers`, `files`, `share_map`, `broadcasts`,
   `audit_log` all carry `tenant_id`; every read/write filters on it (row-level security or an
   enforced ORM scope — open choice, but *enforced*, not by-convention). A broadcast can only
   segment over `subscribers WHERE tenant_id = self`. This is the control that stops customer A
   ever mailing customer B's list.

3. **File store: shared account, partitioned + capability-scoped.** In the central Drive/Zoho
   account, each tenant's files live under a **per-tenant folder**, and — critically — end
   recipients **never get folder access**. A private Drive share grants access to **one file,
   to one email address**; a Zoho external link points at **one file**. Recipients receive
   file-scoped capabilities, never account- or folder-scoped ones, so one requester can't
   traverse to another tenant's (or another requester's) files. Our `share_map` is the source
   of truth for "which Drive/Zoho object backs tenant T's file F," so the external store's flat
   account is never addressed directly by anything the recipient controls.

4. **Deliverability blast radius is shared — call it out.** The one thing genuinely *shared*
   across tenants in the default model is **sending reputation** (and, if/when we add an ESP,
   the sending IP/domain). One tenant's forged sign-ups or spam complaints can degrade
   deliverability for all (`03 §3`). Double opt-in is the primary defense; per-tenant sending
   caps and reputation monitoring are the secondary. In the MVP "send as owner's own Gmail"
   model this is naturally partitioned (each customer sends from their own mailbox), which is a
   quiet virtue of the MVP sending choice — the shared-reputation risk only really arrives with
   shared platform sending infrastructure (post-MVP).

> Data-residency note for the PRD: subscriber PII and the file-share audit trail now live
> wholly in *our* store (that's the point), which makes **us** the primary data controller for
> Israeli Privacy Protection Law / Amendment 13 purposes (`03 §4`) — a cleaner story than
> "we read the customer's whole inbox," but it does put the retention/registration obligations
> squarely on the platform. Flag to advisor + PM.

---

## 6. The 600-share cap → auto-duplication component (detail)

**Corrected fact:** Google's hard limit is **600 direct shares per file** (up to 100 of which
may be groups), and ~100 *concurrent* editors — not 350.
([Google Workspace shared-drive limits](https://support.google.com/a/users/answer/7338880),
[Drive sharing docs](https://support.google.com/drive/answer/2494822)). The founder's "~350"
is therefore a sound **operating threshold with headroom** below the real ceiling, not the
ceiling itself — keep a safety margin (e.g. duplicate at ~550) so a burst of concurrent
requests can't blow past 600 before a duplicate is ready.

This matters **only for the email-only / private-Drive-share lane.** The Zoho public-link lane
has no per-recipient share (one public link serves unlimited openers), and the attachment lane
has none either. So the cap is a bounded, single-lane concern.

**Sharing Engine — auto-duplication (as a component):**

```
share_request(tenant, file, requester_email)          [email-only lane]
  │
  ▼
look up ACTIVE copy for (tenant, file) in share_map     ← share_map tracks copies + counts
  │
  ├─ active_copy.share_count < THRESHOLD (~550) ?
  │        yes → Drive: add requester as viewer on active_copy.drive_id
  │              → share_count++ , log
  │
  └─ no (near cap) → provision NEXT copy:
             1. Drive: copy the file  → new drive_id     (idempotent: keyed on a copy-intent id
             2. share_map: insert new copy row, count=0,  so retries don't spawn duplicates)
                mark it ACTIVE, retire the old one
             3. share requester on the new copy → count=1 → log
```

Design notes / risks the engineer will need:
- **Transparency:** the recipient always gets *a* working private share; which physical copy
  backs it is invisible. `share_map` (not the Drive folder) is the source of truth.
- **Concurrency:** the "near cap → duplicate" branch must be **serialized per (tenant, file)**
  (advisory lock / queue) or two simultaneous requests race and either double-provision or
  overshoot 600. This is the one sharp edge in the component.
- **Idempotency:** copy-provisioning is keyed on an intent id so a retried job reuses the
  copy it already made instead of spawning a third.
- **Storage/quota:** duplicates consume central-account Drive storage; a very popular file
  becomes N copies. Bounded and cheap, but the platform's Drive quota is now a shared resource
  to monitor (a multi-tenancy capacity concern, not a correctness one).
- **Open — verify empirically:** exact API behavior of `drive.permissions.create` as it nears
  the limit (does it error at 600, or silently degrade earlier?), and whether the limit counts
  *pending* shares. This is a spike item, not a design blocker.

---

## 7. Open questions / risks for the PRD, and a recommended-but-open default stack

### Open questions & residual risks (ranked)

1. **NetFree whitelisting of the Zoho *public link* is the top external risk (unchanged).**
   The entire filtered-internet lane rests on "Zoho WorkDrive public links pass NetFree." `04`
   reports the filter spike supports this, but it is a **third-party policy we don't control**
   and could change. If it breaks, the filtered-internet large-file lane collapses to
   attachment-only. **Keep as the #1 thing to re-verify and monitor**; keep the delivery lane
   pluggable so another whitelisted host could be swapped in.
2. **Zoho WorkDrive download speed / UX** (`00 §3` reports ~100–250 KB/s). It *works* but is
   slow; large files may frustrate. This is the stated motivation for the optional "own domain,
   faster delivery" power tier — size the pain in the PRD before deciding how hard to push it.
3. **API automation feasibility (the `04` next-spike, still open):** confirm end-to-end via API
   without Make — (a) Drive private-share to an email + copy + re-share at the cap; (b) Zoho
   `POST /api/v1/links` create-external-link + upload; (c) the full "inbound → verify → share →
   reply" loop. WorkDrive's external-share API is confirmed to exist
   ([WorkDrive API](https://workdrive.zoho.com/apidocs/v1/externalsharing/createsharelink));
   the Drive copy-at-cap behavior (§6) needs an empirical spike.
4. **First-party Drive scope & Google policy confirmation** (§2 nuance): confirm the exact
   Drive scope for the platform's own account and that a single self-owned account stays
   outside external-user CASA. Advisor + a documented Google-policy citation before locking.
5. **Inbound mail layer choice** (see stack below): self-hosted MX vs. an inbound-parse
   provider changes the deliverability, DMARC-results plumbing, and per-address routing story.
6. **Shared sending reputation** (`03 §3`, §5 above) — only bites once we add platform-owned
   sending infra; the MVP "send-as-owner-Gmail" model defers it. Flag for the scaling PRD.
7. **Central-account single point of failure / ToS:** all tenants' files in one Google + one
   Zoho account means one account suspension is a platform-wide outage, and bulk automated
   sharing may bump provider fair-use/ToS limits. Monitor; consider a small pool of accounts
   as a later resilience step (don't prematurely shard).

### Recommended-but-open default stack (each line = a default + its one-line why; all reversible)

| Layer | Default (open) | Why this default |
|---|---|---|
| **Inbound mail** | Owned domain with **catch-all + plus-addressing**; **inbound-parse provider** (SendGrid/Mailgun/Postmark) *or* self-hosted MX (Postfix→webhook) — **open** | Parse providers give signed webhooks + computed auth-results for near-zero ops (`03 §1`); self-host trades ops for control/cost. Decide on volume + cost. |
| **File stores** | **Central Google Drive** (email-only lane) + **Central Zoho WorkDrive** (filtered lane) — **fixed by the model, not open** | These two are *the* mechanisms that pass the two filter regimes (`04`); they're the product, not a swappable default. |
| **Sender (MVP)** | **Owner's own already-whitelisted Gmail, ≤500/day** | Locked in `00 §6a`; no domain/ESP needed; naturally partitions sending reputation (§5). |
| **App/runtime** | Boring managed runtime (single service, not microservices) | Team is small (agents); one deployable is easier to reason about and reverse. Split later only if a lane needs it. |
| **Datastore** | One relational DB (Postgres-class), row-level tenant scoping | Multi-tenant isolation (§5) wants transactional integrity + enforceable row scoping; hand schema detail to database-engineer. |
| **Queue / locks** | A durable job queue with per-`(tenant,file)` serialization | Needed for the §6 duplication race and for retry-safe outbound sends. |
| **Secrets** | KMS-backed envelope encryption for the *platform's own* Drive/Zoho/ESP creds | Blast radius shrank vs. OAuth model, but the platform's own store creds are now the crown jewels — treat them like a vault (`03 §1`). |

Nothing here is locked except what `00 §6a` already locked and the two file stores the model is
built on. Language/framework, the inbound-mail choice, and the datastore product are left open
for the Design/Build stage and the advisor consult on the irreversible calls (inbound mail
layer; first-party Google scope).

---

## 8. Summary (for the orchestrator)

The refined "platform owns one domain + one dedicated inbound address per customer + central
platform-owned file stores" model **hangs together end-to-end**. Every stage maps to a proven
primitive: catch-all inbound mail on our own MX, DMARC results our own mail layer already
computes, a first-party Drive/Zoho account we control, and a subscriber list that lives in
*our* database rather than the customer's Google. The three delivery lanes from `04`
(private Drive share / Zoho public link / small-file attachment) each attach cleanly to the
pipeline, and the anti-spoofing and consent controls from `03` (DMARC gate, double opt-in,
allowlist-or-confirm, rate limits, audit log) sit exactly where they need to — mostly *easier*
now that we own the receiving MX.

**Biggest simplification it buys:** it **deletes per-customer Google OAuth**, and with it the
CASA annual-audit regime and the full-inbox breach blast radius (`03 §1`) — the single most
expensive, hardest-to-reverse risk in the earlier model, removed by design. Customer OAuth
survives only as an opt-in "use your own Drive/domain" power tier, so the default costs nobody
that burden.

**Intent classification** is best solved structurally, not by NLP: per-purpose plus-token
addressing (`cust-<id>+subscribe@`, `cust-<id>+file-<token>@`) makes intent a lookup, with
content classification only as a low-trust fallback for un-tokenized mail — which also shrinks
the attack surface.

**Top remaining risk:** the filtered-internet large-file lane depends entirely on a third-party
policy we don't control — **NetFree continuing to whitelist Zoho WorkDrive public links**. It
tested positive in the founder's spike, but if it changes, that lane collapses to
attachment-only. Keep the delivery lane pluggable and keep re-verifying it. (Correction worth
carrying forward: Google's real direct-share cap is **600/file**, not 350 — so "~350" is a safe
threshold with headroom, and the auto-duplication component is validated but should trigger
with margin and serialize per file to avoid racing past 600.)

---

## Sources
- [Google Workspace — Shared drive limits in Google Drive](https://support.google.com/a/users/answer/7338880)
- [Google Drive Help — Share files from Google Drive](https://support.google.com/drive/answer/2494822)
- [Zoho WorkDrive API — Create external share link](https://workdrive.zoho.com/apidocs/v1/externalsharing/createsharelink)
- Prior internal research: `00-discovery-synthesis.md`, `04-refined-problem-model.md`, `03-security-privacy-risks.md`
