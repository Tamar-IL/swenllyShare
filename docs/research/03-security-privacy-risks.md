# Security & Privacy Risk Research — Inbox-Driven Automations
**Owner:** appsec-engineer · **Phase:** Discovery (research, not build) · **Date:** 2026-09-07

**Product under review:** email-marketing platform, targeting filtered-internet users
(likely no custom domain), with two novel inbox-driven automations:
1. Auto-subscribe: inbox is watched for "please subscribe" emails → sender added to a list → confirmation sent.
2. Auto-file-share: inbox is watched for "please share this file" emails → a private file is
   automatically shared/attached to the requester.

**Bottom line up front:** feature (2) as literally specified — "share a private file because
an email asked for it" — is not shippable without a hard authentication gate on the trigger.
Email `From:` is a self-reported header with no cryptographic guarantee; anyone can put
`victim@company.com` in it. Do not build the naive version. See §2 and the minimum-safe design.

---

## 1. Inbox access risk & scopes

To watch an inbox for "subscribe me" / "share this file" emails, the product needs
**read access to the owner's mailbox**, which is the highest-blast-radius integration this
product can build — a breach of the app's OAuth token store means an attacker can read
**every email the owner has ever received**, not just marketing-relevant ones.

### Gmail API
- Gmail is the most likely first integration for individual/small-business users with
  filtered/consumer internet and no custom domain (they're on `@gmail.com`).
- Scope tiers: **non-sensitive** (no review) → **sensitive** (`gmail.send`: brand
  verification only, no security audit) → **restricted** (`gmail.readonly`, `gmail.modify`,
  `gmail.metadata`, `https://mail.google.com/`: OAuth verification **plus an annual
  third-party CASA security assessment**) — a scope's presence in the request set
  upgrades the *whole app* to the most restrictive tier it touches
  ([Google, restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification);
  [Unipile scope guide](https://www.unipile.com/gmail-api-scopes-guide/)).
- **CASA cost and burden is a real product-viability input, not a footnote.** Reported
  ranges vary by tier/assessor: roughly **$500–$4,500** at the low end up to
  **$5,000–$75,000+** for higher tiers, **repeated annually**, with a first-time cycle of
  **6–12 weeks** end to end
  ([DeepStrike CASA overview](https://deepstrike.io/blog/google-casa-security-assessment-2025);
  [Explosion — Gmail API/OAuth/CASA guide](https://www.explosion.com/210203/gmail-api-integration-guide-oauth-scopes-and-casa/)).
  For an early-stage product this is a meaningful recurring cost and a hard go/no-go gate
  before Gmail read-access can go to production for external users.
- **Least-privilege scope for this product:** the read-side need is narrow — "does this
  message match a subscribe/share-request pattern" — so `gmail.metadata` (headers +
  labels only, still restricted, still needs CASA) is the ceiling; do not request
  `gmail.modify` or `https://mail.google.com/`. If replies must be sent,
  `gmail.send` alone (sensitive, not restricted) covers the outbound side and should be
  requested as a **separate, narrower** grant from any read scope.
- **Best option: avoid mailbox-read scopes entirely** (see "Alternatives" below) — this is
  the only way to dodge CASA and the associated blast radius for the MVP.

### Microsoft Graph (Outlook/M365, if targeted later)
- Same shape of tradeoff: prefer **delegated** permissions (`Mail.Read` + `Mail.Send`) over
  the broader `Mail.ReadWrite`, and never use **application permissions** (app-only, no
  signed-in user, tenant-wide mailbox access) for this use case — application permissions
  "carry the most privacy risk" per Microsoft's own guidance
  ([MS Graph best practices](https://learn.microsoft.com/en-us/graph/best-practices-graph-permission);
  [permissions overview](https://learn.microsoft.com/en-us/graph/permissions-overview)).

### IMAP OAuth (generic / other providers)
- IMAP typically only exposes coarse folder-level access — no per-message metadata-only
  scope like Gmail's — so an IMAP integration is *effectively* full-mailbox read access.
  Treat any IMAP-based mailbox connector as equivalent to the most restricted Gmail scope
  for risk-rating purposes, regardless of what the provider calls it.

### Token storage & blast radius
- OAuth refresh tokens for mailbox access are long-lived bearer credentials. If the
  app's token store is breached (DB dump, SSRF into a secrets store, insider), the
  attacker inherits **read access to every connected owner's full inbox** for as long as
  the token is valid — password resets, 2FA codes, financial correspondence, everything,
  not just subscribe/share-request emails. This makes the token store the single highest-
  value target in the whole system and it must be treated like a payments vault: encrypted
  at rest with envelope encryption (KMS-backed), scoped per-tenant keys ideally, short
  access-token lifetimes, refresh-token rotation, and alerting on anomalous token use
  (new IP/geo, unusual call volume).

### Alternatives that avoid full-inbox access (recommended for MVP)
These are lower-privilege and dodge CASA entirely because the app never touches the
owner's real inbox:
- **Dedicated forwarding/receiving address** (e.g. `owner-abc123@inboundmail.yourapp.com`,
  or, per-list, a `list+subscribe@` plus-address): the owner forwards or CCs
  subscribe/share-request emails, or publishes this address as the contact point, instead
  of granting the app OAuth access to their real mailbox. The app only ever sees mail
  explicitly routed to it.
- **Inbound-parse webhook** (SendGrid Inbound Parse, Mailgun Routes, Postmark Inbound):
  provider receives mail for a subdomain/address the app owns and POSTs the parsed
  message to a webhook. Zero OAuth scope, zero CASA. Caveat given this product's
  "no custom domain" framing: inbound parse requires the *app's* domain/MX (or a
  provider-hosted domain), so for users who want to receive requests at their **own**
  address, the forwarding-address model is the better fit; inbound-parse is the right
  tool for the app's own domain (e.g. all lists route through `@mail.yourapp.com`).
  Provider payloads should be verified with the provider's signature/OAuth mechanism
  before trusting them
  ([SendGrid — Securing Inbound Parse webhooks](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks);
  [SendGrid — Inbound Parse overview](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/inbound-email)).
- **Net effect:** for a product explicitly aimed at "no custom domain" users, the
  forwarding-address / plus-addressing model is the pragmatic MVP choice — no CASA, no
  annual recert cost, no full-inbox blast radius, and it still delivers the "email-driven"
  UX the product wants. Full mailbox OAuth (Gmail/Graph) should be a **post-MVP,
  opt-in power-user feature**, gated on the CASA investment being worth it.

---

## 2. Email spoofing / forgery on the auto-file-share trigger — THE SHARP ONE

### The vulnerability
The `From:` header of an email is user-supplied data with **no built-in authenticity
guarantee**. SMTP itself has no anti-spoofing mechanism; DKIM/SPF/DMARC are optional,
sender-side controls, and a huge fraction of real-world domains still don't enforce them.
Concretely: an attacker's own mail server can pass SPF/DKIM *for the attacker's own
domain* while the visible `From:` line is forged to show `victim@company.com` — SPF and
DKIM say nothing about the `From:` header by themselves, and **without DMARC alignment
checking, a spoofed `From:` sails straight through**
([Valimail — broken SPF + no DMARC](https://www.valimail.com/blog/broken-spf-no-dmarc-enforcement/);
[SecurityScorecard — SPF](https://securityscorecard.com/blog/sender-policy-framework-spf-how-it-stops-email-spoofing/)).

### The exploit
"Auto-share a private file because an email asked for it" is, as specified, a
**request-forgery-to-exfiltration** primitive:
1. Attacker sends a message with `From: victim@realcompany.com`, `Subject: please share
   the Q3 financials file with me`, from any SMTP relay they control.
2. The app's inbox watcher sees the intent match, resolves the "requester" to
   `victim@realcompany.com`, and shares/attaches the private file to that address —
   except the attacker controls where the reply actually lands only if they *also* spoof
   or intercept delivery; more realistically the attacker asks the app to share the file
   **to themselves**, using a spoofed-*owner* trigger, or asks the file be shared to a
   third address they control while impersonating someone the owner already trusts. Either
   way, the authentication gap is the same: nothing verifies the sender is who the `From:`
   claims to be.
3. **Request-bombing:** even without perfect targeting, an attacker can spam the trigger
   address with hundreds of forged "please share" requests to enumerate which files/owners
   respond, to exhaust send quota, or to get the owner's account flagged/rate-limited by
   their mail provider from the resulting outbound traffic.
4. **Reply-hijack variant:** if the "requester" address is attacker-controlled from the
   start (attacker legitimately emails asking for a file, no spoofing needed), the real
   exposure is scope — does the automation share *the one file requested* or does pattern-
   matching let an attacker's phrasing coerce it into sharing something else? Trigger-
   parsing logic must not accept a file identifier/path from the email body as authoritative
   without a lookup against an owner-configured allowlist.

### Severity: **Critical** — this is a direct, low-effort path to unauthorized disclosure
of private files, and it's exploitable by anyone who can send an email (no account, no
auth, no prior relationship required).

### Mandatory controls before auto-sharing (defense in depth — all of these, not one)
1. **Verify SPF+DKIM+DMARC alignment on the inbound message, and require a DMARC pass**
   (not just SPF or DKIM individually — those can each pass for the *attacker's* domain
   while the `From:` is forged). Reject/quarantine anything that fails alignment; never
   auto-share on a DMARC-fail or DMARC-absent message. If receiving via a provider
   (SendGrid/Mailgun/Postmark/Gmail API), use the authentication results the provider
   already computed and attaches to the message (`Authentication-Results` header /
   webhook payload field) rather than re-implementing DNS lookups.
2. **Never trust `From:` alone for identity, even on a DMARC pass** — DMARC only proves
   the sending *domain* is legitimate, not that this specific mailbox is who the file
   owner intended. Auto-share must additionally require the requester's address to be on
   an **owner-curated allowlist** (explicit contacts, or previously-confirmed subscribers)
   before any file leaves the system automatically. Unknown senders — even DMARC-clean
   ones — fall back to a manual-approval queue, not auto-share.
3. **Confirmation step (double opt-in analog for sharing):** for first-time or non-
   allowlisted requesters, send a confirmation link back to the requester ("click to
   receive the file") rather than attaching it directly. This defeats spoofing outright
   (the attacker doesn't control the spoofed victim's inbox to click the link) and gives
   the real owner a chance to notice/cancel an unexpected share.
4. **Capability tokens, not free-text matching, for the actual grant:** the "share this
   file" trigger should resolve to a signed, single-use, short-TTL capability token bound
   to (file id, requester address, request timestamp) — never let LLM/regex intent-parsing
   directly call the share API with attacker-influenced parameters.
5. **Rate limits per sender address, per owner account, and per file** (e.g. N share-
   requests/hour), plus anomaly alerting on the owner's dashboard ("5 share requests for
   the same file from different addresses in the last hour") so request-bombing degrades
   gracefully instead of silently succeeding at scale.
6. **Audit log every auto-share decision** (sender, DMARC result, allowlist hit/miss,
   confirmation status, file, timestamp) — this is both a forensic requirement and the
   dataset that lets the owner later ask "who has this file gone to."

### Minimum-safe design — auto-file-share
```
inbound email
   → provider/mailbox auth-results check → require DMARC pass, else → hold for manual review
   → sender in owner's allowlist?
        no  → send confirmation-request to sender, do NOT attach file; owner notified
        yes → issue single-use signed capability token scoped to (file, sender)
              → share via time-limited signed link (not raw attachment) → log
   → rate limit + anomaly check on every step
```
Sharing via a **time-limited signed link** rather than an email attachment is itself a
control: it can be revoked, it doesn't live forever in the requester's mailbox/forwarding
chain, and it doesn't require the app to know it will never be re-sent to a wrong address.

---

## 3. Auto-subscribe abuse & consent

### The vulnerability
Symmetrically to §2: if "add sender to the list because they emailed asking to
subscribe" trusts `From:` without verification, an attacker (or a mis-typed forward, or a
mailing-list bounce loop) can **add arbitrary third-party addresses to the list who never
asked to be there.**

### Security consequence (the part this role owns — legal depth deferred to PM)
- Emailing addresses that never opted in is how sending domains/IPs get flagged by spam
  filters and land on RBLs (real-time blacklists); a handful of spam-trap hits or
  spam-complaint reports from forged sign-ups can burn a sending domain/IP's reputation
  fast, which then degrades deliverability for **every legitimate subscriber** on the
  platform, not just the poisoned list. This is a shared-infrastructure risk if the
  product uses shared sending IPs across customers (likely, given "no custom domain"
  users).
- List-poisoning is also a vector for abuse-reporting the *product itself*: an attacker
  can forge sign-ups for a target's address, causing the target to receive unwanted
  marketing mail, then report the platform as spam to the target's own provider —
  reputational and deliverability damage the product didn't cause but will absorb.
- There is legal-consent overlap here (CAN-SPAM/GDPR/Israeli law) that belongs to
  product-manager/GRC to size in detail; from a pure security-of-the-system lens the
  actionable point is: **the security control and the legal control are the same
  control** — double opt-in.

### Mandatory control
- **Double opt-in, no exceptions, even for the "auto" path.** "Auto-add" should mean
  *auto-send-confirmation*, never *auto-add-to-active-list*. Only move a sender to the
  active/sendable list after they click the confirmation link. This single control also
  closes the request-bombing variant of this abuse (a bot spamming "subscribe me" emails
  from thousands of forged addresses just generates confirmation emails to those
  addresses, not deliverable-list growth — still worth rate-limiting the confirmation-send
  step itself to avoid becoming a spam-relay-via-confirmation-email vector).
- Apply the same SPF/DKIM/DMARC-awareness from §2 opportunistically here too (it's cheap
  once built), but treat double opt-in as the load-bearing control, since consent, not
  authentication, is the actual requirement — even a *genuine* sender's raw "subscribe me"
  email is not, by itself, informed consent to receive ongoing marketing mail in most
  consent frameworks.

---

## 4. Privacy / data handling

- **What's stored:** subscriber PII (email address, name if parsed, request timestamps,
  possibly message snippets used for intent-matching), OAuth tokens (if mailbox-connect
  path is used), and — for the file-share feature — an audit trail of who received which
  private files.
- **What a breach exposes:** worst case is the mailbox-OAuth path (§1) — full inbox read
  access for connected owners. Even without that, a breach of the subscriber DB exposes
  every list's full subscriber roster (email addresses, and list membership, which is
  itself sensitive — e.g. membership on a political or health-related mailing list is a
  special-category-adjacent inference in some frameworks) plus the file-share audit trail,
  which reveals who has received which private documents — potentially more sensitive than
  the documents' contents.
- **Retention:** define and enforce retention limits for (a) raw inbound email content used
  for intent-matching — do not retain full message bodies longer than needed to make the
  subscribe/share decision, (b) confirmation-pending records for un-confirmed "subscribes"
  (attacker-forged ones will never confirm — purge these on a short TTL rather than
  accumulating forged-address junk indefinitely), (c) OAuth tokens on disconnect/uninstall
  (revoke + delete promptly, don't just soft-delete).
- **Encryption:** PII and OAuth tokens encrypted at rest (KMS-backed), TLS in transit for
  all mail-provider webhooks and API calls; inbound-parse webhook payloads should be
  validated via the provider's signature scheme before being trusted
  ([SendGrid webhook security](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks)).
- **Regulatory touchpoints (high level — size in detail with PM/GRC):** GDPR governs any
  EU-resident subscriber/owner data (lawful basis for processing, data subject rights,
  breach notification within 72 hours, and mailbox-read access likely requires a DPA with
  the mail provider acting as sub-processor). Israel's Privacy Protection Law (and its
  2024/2025 Amendment 13 update raising enforcement powers/fines) applies to Israeli-
  resident subscriber data and has its own database-registration and security-obligation
  regime distinct from GDPR. Flag both explicitly to PM before committing to the
  mailbox-OAuth path, since "the app can read the owner's full inbox" changes the
  processing-scope conversation with any of these regimes materially versus the
  forwarding-address alternative.

---

## Prioritized risk register

| # | Risk | How it's exploited | Severity | Control that closes it |
|---|------|--------------------|----------|--------------------------|
| 1 | **Spoofed "share this file" trigger** | Forge `From:` on an unauthenticated SMTP message; no relationship or account needed | **Critical** | Require DMARC pass + owner allowlist + confirmation link + capability token before any auto-share; never attach directly (§2) |
| 2 | **Forged "subscribe me" → list poisoning** | Forge `From:` (or genuinely misuse) to add non-consenting addresses; poisons deliverability platform-wide | **High** | Double opt-in enforced even on the "auto" path; confirmation-send itself rate-limited (§3) |
| 3 | **OAuth token store breach = full-inbox blast radius** | DB/secret-store compromise exposes long-lived refresh tokens for every connected mailbox | **High** | Avoid mailbox OAuth for MVP (forwarding address / inbound-parse instead); if used, KMS envelope encryption, short-lived access tokens, rotation, anomaly alerting (§1) |
| 4 | **Request-bombing the share/subscribe trigger** | Automated flood of forged requests to enumerate files, exhaust quota, or trigger provider spam flags | **Medium** | Rate limits per sender/account/file; anomaly alerting; confirmation-based flow naturally throttles impact (§2, §3) |
| 5 | **Restricted-scope compliance/cost gap** | Shipping Gmail `gmail.modify`/`mail.google.com` scope without budgeting CASA (recurring $ + 6–12wk cycle + annual recert) | **Medium** (business risk, security-adjacent) | Scope to `gmail.metadata`/`gmail.send` at most, or skip mailbox OAuth entirely for MVP (§1) |
| 6 | **Inbound-parse/webhook payload spoofing** | Attacker POSTs directly to the app's inbound webhook, bypassing the mail provider entirely | **Medium** | Verify provider signature (ECDSA/OAuth) on every inbound webhook call; never trust an unsigned payload (§1) |
| 7 | **File-shared-via-attachment persistence** | Attachment lives forever in requester's/forwarding chain's mailbox even if access should later be revoked | **Medium** | Share via time-limited, revocable signed link instead of raw attachment (§2) |
| 8 | **Over-retained raw inbox content** | Full message bodies retained indefinitely for intent-matching, expanding breach exposure | **Low–Medium** | Short retention TTL on raw content; purge unconfirmed forged-subscribe records (§4) |

---

## Minimum-safe design summary

**Auto-subscribe:** inbound "subscribe" email → **always** send confirmation link,
**never** auto-add to sendable list → only activate on click. Rate-limit confirmation-sends
per source address to avoid becoming a spam-relay.

**Auto-file-share:** inbound "share" email → require DMARC pass on the message → check
requester against an owner-curated allowlist → if not allowlisted, send a confirmation
request instead of sharing → on confirmed/allowlisted match, issue a single-use signed
capability token and deliver via a **time-limited revocable link**, not a raw attachment
→ log every decision → rate-limit per sender/account/file.

**Mailbox-access architecture (both features):** prefer a **dedicated forwarding address /
plus-addressing** or a **signature-verified inbound-parse webhook** over full mailbox OAuth
for MVP — this avoids Gmail/Graph restricted-scope status, the CASA annual security-
assessment cost/burden, and the full-inbox blast radius of a token-store breach entirely.
Reserve mailbox OAuth (with `gmail.metadata`-tier scoping, KMS-encrypted token storage, and
a budgeted CASA line item) for a later, opt-in power-user tier once the MVP has proven demand.

---

## Sources
- [Google — Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Google — Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [DeepStrike — Google CASA Security Assessment 2026](https://deepstrike.io/blog/google-casa-security-assessment-2025)
- [Explosion — Gmail API Integration Guide: OAuth, Scopes, and CASA](https://www.explosion.com/210203/gmail-api-integration-guide-oauth-scopes-and-casa/)
- [Unipile — Gmail API Scopes Explained](https://www.unipile.com/gmail-api-scopes-guide/)
- [Microsoft Learn — Overview of Microsoft Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-overview)
- [Microsoft Learn — Best practices for using Microsoft Graph permissions](https://learn.microsoft.com/en-us/graph/best-practices-graph-permission)
- [Valimail — Broken SPF + no DMARC enforcement](https://www.valimail.com/blog/broken-spf-no-dmarc-enforcement/)
- [SecurityScorecard — Sender Policy Framework (SPF): How It Stops Email Spoofing](https://securityscorecard.com/blog/sender-policy-framework-spf-how-it-stops-email-spoofing/)
- [Twilio/SendGrid — Securing your Inbound Parse Webhooks](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks)
- [Twilio/SendGrid — Inbound Email Parse Webhook](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/inbound-email)
