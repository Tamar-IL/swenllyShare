# PRD — Swenlly File-Sharing (standalone product)

**Status:** Approved for build (Discovery complete and validated — see `docs/research/07`).
**Owner:** Product Manager · **Date:** 2026-09-07
**Precedence:** This PRD wins over all research docs; see `00-README.md` for the full order.
**Grounded in:** `research/03`, `04`, `05`, `06`, `07` (+ founder decisions locked 2026-09-07).
**Relationship to `01`:** shares the same delivery engine (Zoho public link + Drive private
share + attachment + auto-duplication). `01` embeds the two-button pattern inside broadcasts;
**this** product is the file-sharing surface on its own — sellable and usable without the
mailing platform.

> **One-line thesis.** Publishing a file that people on filtered/email-only internet can
> actually open — without owning a whitelisted domain — is a concrete, repeated pain (the
> incumbent שלח מסר sells exactly a slice of it). Swenlly File-Sharing turns one upload into a
> link the filtered audience can open **and** an email-request path the email-only audience can
> use, ideally landing both on a **Swenlly-branded page** with the file/video embedded.

---

## 1. Problem

- A file behind a normal public link (S3, Dropbox, a SaaS "download" page) **does not open**
  inside a kosher filter — those domains aren't whitelisted (`research/04`). And an email-only
  recipient (Google services only) can't open **any** external link at all.
- The two blocked audiences need **different** delivery, and the sender has no way to know which
  recipient is which — so a single share must offer **both** paths from one upload:
  - **Filtered-internet** → a **Zoho WorkDrive public link** (the one public-link type that
    passes NetFree).
  - **Email-only** → a **private Google Drive share** to the recipient's own address (openable
    with **no Google account** via email-OTP), triggered by an **email request**.
- Senders want it to look like **their** product, not Zoho's: the recipient should land on a page
  that says **Swenlly**, with the file/video embedded — a white-label experience. But a branded
  page on `swenlly.com` only passes the filter **if swenlly.com is itself whitelisted** — which
  makes that whitelisting a hard dependency, not a given (see §5, the central constraint).

---

## 2. Users

| Actor | Who | What they need |
|---|---|---|
| **Sender** (the buyer) | Anyone distributing a file to filtered/email-only recipients | One upload → a link to share + an email-request path + control over the message, file name, and expiry |
| **Recipient — filtered-internet** | NetFree/Rimon/Netspark | Open the file from a link that passes the filter — ideally a Swenlly-branded embed page, else the raw Zoho link |
| **Recipient — email-only** | Google services only | Receive the file by sending a pre-filled request email → get a private Drive share / small attachment back |

**Primary job-to-be-done:** *"Let me hand out one file and have it open for people on filtered
internet and for email-only people alike — under my brand where possible — without a domain."*

---

## 3. Goals & non-goals

**Goals**
1. One upload → **(a)** a distribution link, **(b)** a `mailto:` email-request link, **(c)** a
   settings panel (custom message text, file name, expiry).
2. Deliver correctly to **both** blocked audiences from that one upload.
3. Present a **Swenlly-branded embed page** to the recipient where the filter dependency (§5) is
   satisfied; fall back to the raw filter-passing Zoho link where it is not.
4. Never disclose a file to a forged email request; audit every delivery.

**Non-goals (MVP)**
- Any subscriber list / marketing send (that's `01`; this product does not manage lists).
- Open/click analytics.
- Folders, collaborative editing, versioning, or a full DAM.
- Payments / paywalled files.
- The per-sender **"own Google/Zoho account"** power tier (verified-but-deferred — see §6).

---

## 4. Feature set & flows

### Upload & configure (sender, in-app)
```
Sender uploads file F  ──▶  stored in the platform CENTRAL store (Google Drive + Zoho WorkDrive),
                            under this sender's folder
Sender sets:  custom message text (used in the email-request reply),
              display file name,  expiry (link/share validity window)
System returns:
  (a) DISTRIBUTION LINK  →  Swenlly-branded embed page  (if swenlly.com is whitelisted, §5)
                            ELSE the raw Zoho WorkDrive public link (filter-passing fallback)
  (b) EMAIL-REQUEST LINK →  mailto: cust-<id>+file-<opaque-token>@<platform-domain>
```

### Distribution-link path (filtered-internet recipient)
```
Recipient opens the distribution link:
  P0-satisfied  → Swenlly-branded page, file/video embedded  ("Swenlly", not "Zoho WorkDrive")
  P0-pending    → raw Zoho WorkDrive public link (works, unbranded, slower ~100–250 KB/s)
```

### Email-request path (email-only recipient)
```
1. Recipient clicks the mailto → sends the pre-filled request email.
2. Mailgun Route ──▶ webhook.  AUTH GATE (DMARC pass) + RATE GATE (per sender/customer/file).
3. Resolve file F from the +file-<token> address (lookup — NEVER from body text).
4. Deliver to the requester's OWN address:
       ≤ ~20 MB  → attach directly to the reply, using the sender's custom message text
       larger    → Google Drive private share to that address (email-OTP visitor, no Google
                   account required), with the custom message text in the reply
5. SHARING ENGINE auto-duplicates past the Drive share cap (same spec as `01 §8`).
6. Reply sent.  Every delivery audit-logged.
```

---

## 5. The central constraint — white-label + filter (write the product around this)

This is the load-bearing constraint of the product; it is a founder P0 requirement.

- **What the sender wants:** the recipient lands on a **Swenlly-branded page with the file/video
  embedded** — they should see *"Swenlly,"* not *"Zoho WorkDrive."*
- **Why it's hard:** filters whitelist by **domain**. A branded page served from `swenlly.com`
  passes the filter **only if `swenlly.com` is itself whitelisted by NetFree / Rimon**. That
  whitelisting is a **P0 dependency owned outside the codebase** (a submission-and-approval
  process with a third party we don't control) — the same class of external-policy risk as the
  Zoho-whitelist risk in `research/06 §7.1`.
- **The rule the product ships with:**
  - **Until `swenlly.com` is whitelisted:** the distribution link is the **raw Zoho WorkDrive
    public link** — it passes the filter today, unbranded and slower, but it works. This is the
    fallback and it is never removed.
  - **Once `swenlly.com` is whitelisted:** the distribution link becomes the **Swenlly-branded
    embed page**, with the Zoho link as the embedded/underlying source.
- **Parallel spike (tracked, not a build blocker):** verify the **embed mechanics** — can a Zoho
  WorkDrive file/video be embedded in a page on `swenlly.com` such that it renders inside the
  filter once the domain is whitelisted? Build the branded page behind a flag; keep the raw-Zoho
  fallback as the default path until both the whitelisting **and** the embed spike land.

**Design stance:** treat the branded embed page as a **progressive enhancement gated on the P0
whitelisting**, not a launch precondition. The product is valuable on day one via the raw Zoho
fallback; branding is the upgrade that lands when the dependency clears.

---

## 6. Central store vs. sender's own account

- **Default (MVP): the platform's central accounts.** All senders' files live in **Swenlly's
  own** Google Drive + Zoho WorkDrive, under per-sender folders. **No per-sender OAuth.** This is
  what deletes the Google CASA regime and the whole-inbox blast radius (`research/06 §2`,
  `research/07`). Recipients receive **file-scoped** capabilities only (one file, one address /
  one link) — never folder or account access (`research/06 §5.3`).
- **Optional power tier (verified-but-deferred): the sender's own account.** A sender who wants
  files served from **their own** Drive/WorkDrive/brand can connect their own account. This
  **re-introduces per-sender OAuth** and, at scale on restricted Drive scopes, the CASA question
  — which is exactly why it is an **opt-in upgrade the sender chooses**, not the default everyone
  carries. **Status:** the founder is still verifying this as an option; it is **listed as an
  open question (§10), not built in the MVP** — do not implement it until confirmed.

---

## 7. MVP thin-slice vs deferred

**MVP — IN:**
1. Upload a file to the central store (Drive + Zoho).
2. Generate **(a)** the distribution link (**raw Zoho public link** as the shipping default),
   **(b)** the `mailto:` email-request link with the file token, **(c)** settings: custom message
   text, display file name, expiry.
3. Email-request delivery: DMARC-verify → Drive private share **or** ≤20 MB attachment → reply
   with the sender's custom message → reactive auto-duplication past the share cap.
4. Audit log of deliveries; per-sender/file rate limits.
5. The **Swenlly-branded embed page behind a feature flag**, defaulting OFF until the §5 P0
   whitelisting + embed spike land.

**Deferred (say so):**
- The branded embed page **as the live default** — gated on the swenlly.com whitelisting P0.
- The **sender's-own-account** power tier (§6) — pending founder verification.
- Large file + recipient with **no Google account at all** — the one real gap; small slice, not
  an MVP blocker (`research/04`).
- Folders, versioning, analytics, payments, collaborative features.

---

## 8. Acceptance criteria (testable)

### AC-UPLOAD & LINKS
- **AC-U1** Uploading a file returns all three artifacts: a distribution link, a `mailto:`
  email-request link whose address carries the file's **opaque token**, and an editable settings
  panel (custom message text, display file name, expiry).
- **AC-U2** With the branded-page flag OFF, the distribution link is the **raw Zoho WorkDrive
  public link** and resolves to the uploaded file.
- **AC-U3** With the branded-page flag ON (P0 satisfied), the distribution link is a
  **`swenlly.com`** page that displays **"Swenlly"** branding with the file/video embedded, and
  the raw Zoho link never appears as the visible destination.
- **AC-U4** Expiry is enforced: after the set window, the distribution link and any private share
  no longer grant access.

### AC-REQUEST (email-only path)
- **AC-R1** A DMARC-fail/absent request email produces **no** delivery and is quarantined
  (spoofed-From test).
- **AC-R2** The delivered file is chosen **only** from the `+file-<token>` address, never from the
  email subject/body (body-injection test).
- **AC-R3** A DMARC-verified request delivers the file **to the sender's own From address only**
  — never to a third address.
- **AC-R4** Files ≤ ~20 MB deliver as a direct attachment; larger as a Drive private share
  openable by a recipient with **no Google account** via email-OTP (non-Google test address).
- **AC-R5** The reply uses the sender's configured **custom message text** and display file name.
- **AC-R6** Inbound webhook POSTs are rejected unless the Mailgun signature verifies.

### AC-SHARING-ENGINE (shared spec with `01 §8`)
- **AC-E1** At the Drive share cap, the system auto-duplicates to a new copy and shares from it;
  the requester always receives a working share, no request fails with a raw quota error.
- **AC-E2** Auto-duplication is idempotent and **serialized per (tenant, file)**: concurrent
  requests at the boundary create at most one new copy per intent and never overshoot the ceiling.

### AC-ISOLATION & AUDIT
- **AC-A1** Recipients receive **file-scoped** access only — a private share grants one file to
  one address; a Zoho link points at one file. No recipient can traverse to another file, folder,
  or sender (isolation test).
- **AC-A2** Every delivery is audit-logged (sender/requester, DMARC result, file, timestamp,
  delivery mechanism) and queryable as "who has received this file."
- **AC-A3** A sender can only see and manage their own files (tenant isolation).

---

## 9. Top risks

1. **The `swenlly.com` filter-whitelisting P0** (§5). The branded embed experience — the founder's
   headline requirement — is blocked until a third party we don't control whitelists the domain,
   and the embed mechanics are unverified. *Mitigate:* ship on the raw-Zoho fallback (valuable
   day one); build branding behind a flag; run the whitelisting submission + embed spike in
   parallel; treat branding as progressive enhancement.
2. **NetFree whitelisting of the Zoho public link is itself a third-party policy**
   (`research/06 §7.1`). If it changes, the filtered-internet lane collapses to attachment-only.
   *Mitigate:* keep the delivery lane pluggable; re-verify and monitor.
3. **Forged email request → file disclosure** (`research/03 §2`, Critical class). *Mitigate
   (invariant):* DMARC pass required + file identity from token not body + share only to the
   verified From address + rate limits + audit log.

*Secondary, tracked:* Zoho download speed (~100–250 KB/s — the stated motivation for the "own
domain, faster delivery" upgrade, `research/06 §7.2`); central-account single point of failure
(`research/06 §7.7`); Drive visitor-sharing on a personal account is UNCONFIRMED (`research/05 §1`).

---

## 10. Open questions for the founder (unresolved — not guessed)

1. **Sender's-own-account power tier (§6).** Confirm whether to offer files served from the
   sender's own Drive/WorkDrive/brand as an opt-in upgrade — and accept that it re-introduces
   per-sender OAuth and the CASA question at scale. Not built until confirmed.
2. **swenlly.com whitelisting status & SLA.** What is the submission path and expected timeline
   for NetFree/Rimon to whitelist `swenlly.com`, and does the embed spike confirm a Zoho file/
   video renders on a `swenlly.com` page inside the filter? This gates the branded experience.
3. **Zoho plan & API confirmation.** The founder holds a paid Zoho plan (WorkDrive API assumed
   available) — confirm the plan exposes `POST /api/v1/links` (create external link) + chunked
   upload with one live authenticated call, and capture any per-account link/rate limits
   (`research/05 §2`).
4. **Google Drive account type & real share ceiling.** Personal vs Workspace for the central
   store, and confirm visitor-sharing (no-Google-account open) works on the chosen account type;
   instrument for the real `sharingRateLimitExceeded` ceiling rather than assuming a number
   (`research/05 §1`).
5. **Expiry defaults & the no-Google-account gap.** What default expiry window do senders expect,
   and is the "large file + recipient with no Google account at all" gap acceptable to leave
   unaddressed for the MVP (`research/04`)?
