# Architecture Options & Tradeoffs — Feasibility Research (Discovery Gate)

**Product:** an email-marketing platform whose two novel parts are **inbox-driven automations** —
(1) an inbound email that *subscribes* someone to a list, and (2) an inbound email that *requests a
file* and gets it back automatically. Target environment: **filtered / whitelist-censored internet**
(e.g. Israeli kosher filters — NetFree, Rimon, Netspark) where public links on unknown domains are
blocked by default, and **ideally the operator does not own a custom domain.**

**Status:** RESEARCH ONLY. Nothing here is locked. Technologies the founder named (Zoho WorkDrive,
Google Drive) are treated as *candidates to beat*, not givens. Every option below is evaluated on
four axes: **latency · reliability · cost/limits · fit for {no-domain + filtered-internet}.**

> **The two constraints fight each other.** "No custom domain" and "must work behind a whitelist
> filter" and "good deliverability" cannot all three be maximized at once. Most of this document is
> about *where to spend the one hard constraint you have to relax.* Read the tradeoff callouts.

---

## Problem 1 — Inbox monitoring (detect a subscribe/file request in near-real-time)

The job: know, within seconds, that a specific inbound email arrived, and read enough of it (sender,
subject, body/plus-tag) to classify it as *subscribe* or *file-request NAME*.

**The no-domain fact that eliminates a whole category up front:** every "inbound email parse /
routing" service — **SendGrid Inbound Parse, Mailgun Routes, Postmark Inbound, CloudMailin,
ImprovMX** — requires you to **own a domain and point its MX records at the service.** ImprovMX's own
docs: it "only works if you own a domain and can edit its MX records." [improvmx], [sendgrid-inbound]
So if the operator truly has *no domain*, **none of the parse-webhook services are usable** — they
are only in play once you concede a cheap domain (see Problem 3, where you likely concede one anyway).

That leaves the transports that work against a **free consumer mailbox** (Gmail / Outlook.com) the
operator already has.

| Option | How it works | Latency | Cost / limits | Fit: no-domain + filtered | Verdict |
|---|---|---|---|---|---|
| **Gmail API `watch` + Pub/Sub push** | `users.watch` publishes a Pub/Sub message on mailbox change; your webhook calls `history.list` then fetches the message | **~1–10 s**, usually a few seconds [unipile], [google-push] | Free at this scale. Must **re-`watch` ≤ every 7 days** (do it daily); max **1 notif/sec/user** [google-push]. Needs a **public HTTPS webhook**. Race: notification can arrive *before* the message is queryable — needs 2–3 s retry [unipile] | Works on a **free @gmail.com** — no domain needed. Your webhook host is a normal cloud URL (server-side, not behind the user's filter), so the whitelist is irrelevant to it | **Leading option** for a Gmail-based operator |
| **Microsoft Graph change notifications** | `POST /subscriptions` on `messages`; webhook receives change, you fetch the message | Target **~30 s, not guaranteed** [ms-graph] | Free on Outlook.com/365. Subscription **expires (~3 days for mail), must renew**. Needs **public HTTPS webhook** + validation handshake. 1000 subs/mailbox cap [ms-graph] | Works on a **free outlook.com** account — no domain. Same "server-side webhook" story | Strong **if the operator lives in Outlook**; slower than Gmail |
| **IMAP IDLE** | Persistent TCP `IDLE` connection; server pushes "new mail" events | Provider-dependent. Google's **IMAP IDLE is markedly slower** than its API push [mimestream]; generic IMAP is seconds-ish | Free. **No public webhook required** (outbound connection — big plus for simple/cheap hosting). Must **reconnect ≤ ~29 min** (RFC 30-min cap) and re-IDLE; Workspace admins can disable IMAP [limilabs], [mimestream] | Works on **any provider, any consumer mailbox**, no domain. The long-lived connection is outbound from *your* server, so filters don't touch it | **Best portability / simplest hosting**; accept higher latency & connection babysitting |
| **Plus-addressing / catch-all routing** (`me+subscribe@gmail.com`, `me+file-REPORT@gmail.com`) | Not a transport — a **classification scheme** layered on any option above. Gmail/Outlook deliver `user+anything@` to `user@`; the `+tag` and subject carry intent | Inherits the transport's latency | Free. Gmail supports `+` sub-addressing natively; **catch-all** (arbitrary local-part) needs a domain, so on consumer mail you get `+tags`, not true catch-all | **No-domain friendly** via `+tags` on gmail.com; **true catch-all** (`file+ANYTHING@yourdomain`) is a reason to concede a domain | **Use it regardless** — it's the routing layer, pick a transport under it |
| Polling `messages.list` every N sec | Cron/loop hits the API on an interval | = your interval (10–60 s typ.) | Free but **burns API quota**; trivially simple | Works no-domain | Fallback only; fine for MVP spike |

**Cross-cutting notes.** Gmail push and Graph both need a **publicly reachable HTTPS endpoint** — that
endpoint is *your backend on a cloud host*, **not** something the user reaches through their filter, so
the censored-internet constraint does **not** apply to it. IMAP IDLE avoids even needing that endpoint.
All three are fine on a **free consumer mailbox**, which is what makes them the honest answer to "no
domain." The `+tag` scheme is how you tell subscribe-emails from file-request-emails cheaply without
NLP.

**Leading default:** **Gmail API `watch` + Pub/Sub push** for latency and a clean event model, with
**IMAP IDLE as the portable fallback** for non-Gmail operators. Layer **plus-addressing + subject
parsing** on top for intent classification.

---

## Problem 2 — File delivery that survives filtered internet

**Why public links get blocked (the core mechanism).** Kosher filters (NetFree, Rimon, Netspark) are
**default-deny whitelists**: "any site that hasn't been reviewed is closed by default, and can be
submitted for review. Once one customer submits it and it's opened, it's open to all users." [vice-kosher]
So a Zoho/Drive/S3 public link on a host the filter hasn't whitelisted is **blocked outright** — not
throttled, *blocked*. This is a **domain-reputation/whitelist problem, not a bandwidth problem.**

**The key architectural insight — ride an already-whitelisted domain.** Email itself is delivered to
the recipient's mail client over their provider's domain (**gmail.com / outlook.com are already on
every kosher whitelist** — they're how these users do email at all). An **attachment downloads *inside*
that whitelisted webmail session**, so it **never traverses the web whitelist as a separate host**.
That is why an attachment "just works" behind the filter while a public link on `zoho.com` may not.

**On "faster than Zoho."** Zoho WorkDrive public-link downloads are reported by users at **~100–250
KB/s** [zoho-slow] — and, worse for this product, `zoho.com` is **not guaranteed to be whitelisted**, so
for many recipients it isn't slow, it's *blocked*. Beating it is easy on both axes: an **attachment is
delivered with the email (no second fetch at all)**, and a link served from **an edge CDN on a
whitelisted delivery domain** is far faster than Zoho's origin.

| Option | How it works | Cost / size limits | Fit: no-domain + filtered | Verdict |
|---|---|---|---|---|
| **(a) Email attachment** | File is attached to the auto-reply; downloads inside webmail | **~10–25 MB** practical cap (Gmail 25 MB send, 25 MB receive; many gateways 10 MB). No hosting cost | **Best filter fit** — rides gmail/outlook, bypasses web whitelist entirely. **No domain needed.** Slightly hurts deliverability/spam scoring & send quota | **Leading option for files ≤ ~10–20 MB.** Instant, filter-proof, zero infra |
| **(b) Presigned link — Cloudflare R2** | Private bucket, per-request presigned URL (S3-compatible), served via R2 **custom domain** on Cloudflare's edge | Free tier **10 GB storage, 10 M reads/mo, $0 egress** [r2-pricing]. No hard file-size cap | Fast (edge). **Passes the filter ONLY if the delivery domain is whitelisted** → needs a domain + one-time NetFree/Rimon submission. Not truly no-domain | **Leading option for large files**, *conditional on* conceding a delivery domain |
| **(b) Presigned link — Backblaze B2 + Cloudflare** | B2 private bucket, presigned; Bandwidth-Alliance free egress to Cloudflare edge | Storage ~**$0.006/GB/mo**, 10 GB free; egress via Cloudflare **free** [r2-pricing] | Same filter caveat as R2 (needs whitelisted domain in front) | Cheapest storage-heavy; same domain caveat |
| **(b) Presigned link — AWS S3** | Private bucket, presigned URL, optionally CloudFront | **$0.09/GB egress** (100 GB/mo free tier first year) [r2-pricing] | Same filter caveat; **most expensive egress** | Only if already in AWS; otherwise R2 wins |
| **(b) Google Drive / Zoho private share** | Per-recipient share or public link | Free-ish; **Zoho reported slow** [zoho-slow] | `drive.google.com` is *often* whitelisted (Google is ubiquitous) but **upload/download of Drive is exactly what many org filters block** [palo-drive]; Zoho less likely whitelisted | Fallback; unreliable behind strict filters |
| **(c) Self-hosted / allow-listed delivery domain** | Your own small domain (or R2 custom domain) submitted **once** to NetFree/Rimon whitelist; all files served from it thereafter | Cost of a domain (~$10/yr) + storage backend | **Best of the link options** — one whitelist approval covers every future file; edge-served = fast. **Requires a domain** | **The durable answer for large/repeat files** — pair with (a) for small ones |

**Recommended pattern (size-tiered):**
- **≤ ~10–20 MB → attach it.** Filter-proof, no infra, no domain, instant. This covers the majority of
  marketing collateral (PDFs, images, short docs).
- **> 20 MB → presigned link from a whitelisted delivery domain** (R2 custom domain is the default:
  $0 egress, edge speed), submitted once to the relevant filters.

**Open item to verify (spike):** exact NetFree/Rimon **whitelist submission turnaround** and whether a
*generic* delivery subdomain can be pre-approved. Direct filter docs were not reachable during this
research; the whitelist *mechanism* is confirmed [vice-kosher] but the SLA is not.

---

## Problem 3 — Sending email WITHOUT a custom domain (the deliverability reality)

**The honest baseline:** modern inbox placement (Gmail/Yahoo Feb-2024 bulk-sender rules) effectively
**requires SPF + DKIM + DMARC alignment on a domain you control.** You cannot align DMARC on a domain
you don't own. So "no domain" and "reliable marketing deliverability" are **in direct tension.** Here is
what actually exists:

| Option | How it works | Cost / limits | Fit: no-domain | Deliverability verdict |
|---|---|---|---|---|
| **Brevo free — shared domain** | Send unverified → Brevo **rewrites the From to `@brevosend.com`** to satisfy Gmail/Yahoo rules [brevo] | **300 emails/day free**, shared IP pool | **True no-domain path** — works today | Lands more in spam; From isn't *yours*; fine for MVP/low volume |
| **MailerSend trial domain** | Temporary MailerSend-owned domain, no DNS setup | **100 emails (trial)**, then 500/mo free (**CC required**) [mailersend] | True no-domain for testing | Test-grade only; not a durable sender identity |
| **Gmail / Outlook SMTP or API** | Send as your own `you@gmail.com` | **Free Gmail: ~500 recipients/day (web/API), ~100/day via SMTP**, ≤100 recip/msg [gmail-limits] | No-domain, and **From is a real, trusted consumer address** | Actually *decent* inbox placement (real Google identity) but **tiny volume**; not built for bulk |
| **Amazon SES** | Verify identity, request production | Cheap at scale, but **sandbox only sends to *verified* recipients**; needs verified domain/email + approval [ses-verify] | **Fails no-domain** for arbitrary subscribers | Great later, wrong for no-domain MVP |
| **ESP + cheap subdomain** (Brevo/Postmark/SES on `mail.yourbrand.com`) | You own one cheap domain; ESP signs DKIM on a subdomain | ~$10/yr domain + ESP free/low tier | **Not no-domain** — but the smallest possible concession | **The honest minimum for real deliverability** |

**Tradeoff, stated plainly.** There are exactly two coherent postures:
1. **Genuinely no domain →** send via **Brevo's `@brevosend.com`** (bulk, 300/day) *or* the operator's
   own **Gmail/Outlook** (real identity, ~500/day). Accept: lower/spammier placement (Brevo) or tiny
   volume (Gmail). Good enough to *prove the two automations work.*
2. **Concede one cheap domain (~$10/yr) →** unlocks SPF/DKIM/DMARC alignment, a real ESP (SES/Postmark/
   Brevo paid), true catch-all addressing (Problem 1), *and* a whitelistable delivery domain (Problem 2).
   **One $10 purchase resolves the hardest parts of all three problems at once.**

**Recommendation:** build the MVP on the **no-domain path (Brevo shared or Gmail)** to validate the
novel automations, but **tell the founder up front** that a **single cheap domain is the honest
production minimum** — it is the highest-leverage $10 in the whole system.

---

## Problem 4 — The auto-file-share trigger (inbound → verify → privately share)

Pipeline for "someone emails to request a file and gets it back automatically":

```
1. DETECT   Problem-1 transport fires (Gmail push / IMAP IDLE) → new inbound email event
2. CLASSIFY parse recipient +tag / subject → intent = FILE_REQUEST, extract file token NAME
3. RESOLVE FILE   look up NAME in a file catalog (token → storage object + size + access policy)
4. RESOLVE PERSON authenticate the requester by their From address (see spoofing note)
5. AUTHORIZE      is this file public-on-request, or gated to a known subscriber? apply policy
6. DELIVER        size-tier from Problem 2: attach (≤~20 MB) OR presigned/whitelisted link
7. REPLY          send via Problem-3 path, threaded to the original request
8. LOG            record {who, which file, when} for audit + abuse throttling
```

**Mapping request → file.** A **catalog table**: `token → {storage_ref, display_name, size, policy}`.
The `token` is what the requester puts in the `+tag` or subject (`file+REPORT2025@…`). Keep tokens
**opaque/enumerable-resistant** (not raw filenames) so the catalog isn't a directory listing.

**Mapping request → person.** The requester is identified by their **From address**. This is the abuse
surface: **From is trivially spoofable**, so treating "email from X" as "X is authorized" is unsafe for
any gated file. Mitigations to hand to **appsec** (flagged, not solved here):
- Verify the **inbound message's own SPF/DKIM** result before trusting the sender (the Problem-1
  transport exposes this).
- For gated files, use **double-opt-in / one-time-token replies** rather than trusting raw From.
- **Rate-limit + log per sender** to blunt enumeration and mail-bombing (reply-amplification abuse).
- Never let a request address *arbitrary* storage paths — only catalog tokens (prevents traversal).

> **Handoff:** the spoofing/authorization model is an **appsec** deliverable. Architecture guarantees
> the *seams* exist (SPF/DKIM result available at classify-time; catalog indirection; per-sender audit
> log); appsec sets the *policy* on them.

---

## Recommended-but-NOT-locked default stack

| Concern | Default pick | Why (one line) | Escape hatch |
|---|---|---|---|
| Inbox monitoring | **Gmail API watch + Pub/Sub**, IMAP IDLE fallback | Fastest (~1–10 s), free, works on a free @gmail.com | IMAP IDLE for non-Gmail; polling for the spike |
| Intent routing | **Plus-addressing + subject parse** | Free, no NLP, no domain needed on Gmail `+tags` | True catch-all once a domain is conceded |
| File ≤ ~20 MB | **Email attachment** | Filter-proof (rides whitelisted webmail), instant, no infra | — |
| File > 20 MB | **Cloudflare R2 presigned + custom domain, whitelisted once** | $0 egress, edge-fast, beats Zoho on speed *and* filter-pass | B2+Cloudflare (cheaper storage); S3 (if in AWS) |
| Sending | **Brevo shared `@brevosend.com` OR operator Gmail** (no-domain MVP) | Only real no-domain paths that exist today | **Concede $10 domain + ESP subdomain** for production deliverability |
| Trigger orchestration | **Small stateless backend** (webhook consumer + catalog DB + reply sender) | Boring, cheap, easy to reason about | — |

---

## Top open questions / spikes to de-risk before committing

1. **NetFree/Rimon whitelist SLA (P2, highest risk).** How long to get a delivery domain approved, and
   can a generic subdomain be pre-approved? *Filter docs were egress-blocked in this pass — verify
   directly.* If turnaround is slow/unreliable, the **attachment-only** path becomes mandatory and hard-
   caps file size at ~20 MB.
2. **Is the operator on Gmail or Outlook?** Decides Problem-1 transport (Gmail push vs Graph vs IMAP).
3. **Volume target.** If > ~300/day, the no-domain send options break and a **domain + ESP is forced** —
   settle this at intake, it's the biggest fork.
4. **Attachment deliverability spike.** Do auto-replies *with attachments* from Brevo/Gmail actually land
   in these recipients' inboxes (not spam)? Send 20 test attachments through the real filter.
5. **Gmail push race + `watch` renewal** — confirm the 2–3 s history-lag retry and daily re-watch cron
   behave under load [unipile], [google-push].
6. **Spoofing model (→ appsec).** Confirm the inbound transport surfaces per-message SPF/DKIM results so
   `RESOLVE PERSON` can trust them.

---

### Sources

- [unipile] Gmail API Push Notifications guide (latency, watch/history race) — https://www.unipile.com/gmail-api-push-notifications/
- [google-push] Configure push notifications, Gmail API (7-day watch, 1 notif/sec) — https://developers.google.com/workspace/gmail/api/guides/push
- [mimestream] Mimestream Private Push (Gmail IMAP IDLE slower than API push) — https://mimestream.com/trust/private-push
- [limilabs] IMAP IDLE explainer (30-min connection cap) — https://www.limilabs.com/blog/imap-idle
- [ms-graph] Microsoft Graph change notifications for Outlook (~30 s target, sub renewal, webhook) — https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview
- [improvmx] ImprovMX (requires owning a domain + MX edit; catch-all) — https://improvmx.com/ , https://improvmx.com/pricing/
- [sendgrid-inbound] Inbound parse comparison (all require MX on your domain) — https://mails.ai/blog/best-inbound-email-parsing-api-for-developers
- [postmark] Postmark inbound/pricing (free 100/mo, inbound billed as messages) — https://userjot.com/blog/postmark-pricing-in-2025
- [vice-kosher] Kosher internet filters — whitelist/default-deny mechanism — https://motherboard.vice.com/en_us/article/8q8k45/kosher-internet-filters
- [zoho-slow] Zoho WorkDrive slow-download user reports (~100–250 KB/s) — https://help.zoho.com/portal/en/community/topic/we-are-experiencing-slow-download-from-zoho-workdrive
- [r2-pricing] R2 vs S3 vs B2 egress & free tiers ($0 R2 egress; S3 $0.09/GB; B2 $0.006/GB) — https://tech-insider.org/cloudflare-r2-vs-s3-vs-backblaze-b2-2026/
- [palo-drive] Firewalls commonly block Drive/Dropbox up/download — https://avsyss.medium.com/palo-alto-next-generation-firewall-how-to-bypass-blocked-upload-and-download-on-online-storage-b252d2edf2d4
- [brevo] Brevo free = 300/day, unverified From rewritten to @brevosend.com — https://unspam.email/deliverability/brevo
- [mailersend] MailerSend trial domain (100 emails, no DNS), 500/mo free w/ CC — https://www.mailersend.com/pricing
- [gmail-limits] Gmail free send limits (~500/day web/API, ~100/day SMTP, ≤100 recip/msg) — https://serversmtp.com/limits-of-gmail-smtp-server/
- [ses-verify] Amazon SES sandbox requires verified sender AND recipient — https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html
