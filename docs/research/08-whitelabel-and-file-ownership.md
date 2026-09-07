# Feasibility Spike — White-Label Embed & Customer-Owned File Accounts

**Owner:** backend-engineer · **Phase:** Discovery (research only, no code) · **Date:** 2026-09-07

**Caveat carried from `05`/`07`:** direct fetches of `help.zoho.com` pages are network-blocked
from this environment (`EGRESS_BLOCKED`); facts below come from cross-checked web-search
snippets (search-result summaries, third-party write-ups, GitHub examples), not primary-source
page reads. Treat domain/scope specifics as **needing a 15-minute live-account confirmation**,
not as blockers — flagged inline where it matters.

---

## Question 1 — White-label embed of a Zoho WorkDrive file on our own branded page

### Verdict: **BUILDABLE-WITH-CAVEAT** — the caveat is the whole point of the question

**1a. Does WorkDrive support an embeddable iframe?**

Yes. WorkDrive has a **"New embed code"** action (Share dropdown → New embed code) that
generates an `<iframe>` snippet, separate from the plain "New External Share link" used for
the raw public link ([Zoho WorkDrive — Create and manage embeds](https://www.zoho.com/workdrive/videos/share-files-and-folders/create-and-manage-embed-code.html);
[Zoho Learn — Embed code from Zoho WorkDrive](https://help.zoho.com/portal/en/kb/zoho-learn/knowledge/editor/articles/embedd)).
Observed embed markup shape:

```html
<iframe src="https://workdrive.zohoexternal.com/embed/<fileToken>?toolbar=false&appearance=light&themecolor=green"
        scrolling="no" frameborder="0" allowfullscreen="true" width="800" height="520"></iframe>
```

This iframe *can* be dropped into a page on `swenlly.com` — technically nothing stops us
from putting Zoho's iframe on our own branded HTML, hiding all Zoho chrome (`toolbar=false`),
and making the page read as "Swenlly." That part of the ask is straightforwardly buildable.

**1b. The critical filter question — confirmed, and it's a bigger problem than framed**

Your reasoning is correct and the search evidence supports it directly: NetFree/Rimon/Netspark
are **whitelist-based filters that gate at the domain/DNS level before the page loads**
("the DNS server checks a website address against a blocklist [or whitelist] before the page
loads" — [KosherSignal — Kosher Web Filter: How It Works](https://koshersignal.com/blogs/articles/kosher-web-filter-guide);
whitelist-mode filters block "everything else" by default —
[Vice — Kosher Internet](https://www.vice.com/en/article/kosher-internet-filters/)). That
means filtering is not a per-resource content scan of a rendered page; it is a gate on whether
the **browser is allowed to open the domain at all**. A blocked parent domain never receives a
response, so the browser has nothing to render — the iframe tag never executes, because the
document containing it never loads. **An iframe pointing at a whitelisted domain does not
rescue a page on a non-whitelisted domain.** So:

> **White-label branded page ⇒ `swenlly.com` itself must be submitted to and approved by
> NetFree/Rimon/Netspark as a whitelisted domain — a manual, per-vendor, per-domain process,
> not something the file-sharing product controls.**

This confirms the founder's stated implication plainly and is worth restating as the
headline risk: **today, zero part of the "white-label branded Swenlly page" plan works for
filtered-internet recipients until that whitelisting is granted** — which may take time, may
be denied or delayed, and is outside engineering's control (it is the same category of process
`04-refined-problem-model.md` already flags as the post-MVP "domain we help get whitelisted"
step, but this spike makes explicit that *the branded-embed page itself* is the trigger for
needing it, not merely "faster delivery").

**1c. A second, sharper problem the domain-whitelisting alone does not fix**

Even after `swenlly.com` is whitelisted, the iframe's own `src` is a **different domain than
the one already validated in the founder's filter spike.** The filter spike (per `04`)
confirmed the *raw public share link* passes NetFree — that link lives on the
`workdrive.zoho.com` domain family. The **embed iframe's `src` resolves to
`workdrive.zohoexternal.com`** — search evidence shows this is Zoho's dedicated
embed-viewer subdomain, distinct from the WorkDrive app domain
(`workdrive.zoho.com/home/...`) and from the download domain (`download.zoho.eu/v1/workdrive/...`
in some regions). **This subdomain was not part of what the founder's spike tested** and
filter vendors commonly whitelist specific subdomains/paths rather than blanket
`*.zoho.com`/`*.zohoexternal.com` wildcards. **Net effect: white-labeling doesn't just require
whitelisting `swenlly.com` — it may *also* require a second, separate whitelisting request for
`workdrive.zohoexternal.com` (the embed domain), even though the plain public link on
`workdrive.zoho.com` already works today.** This must be live-tested (open a
`workdrive.zohoexternal.com/embed/...` URL directly from a NetFree-filtered device) before
committing to the embed approach — it is a 10-minute check, not a build risk, but it is not
provably true from documentation alone and could invalidate the whole embed plan if that
subdomain isn't (and can't easily be) whitelisted.

**Recommendation:** for filtered-internet recipients, do **not** build the white-label embed
page as the default MVP path. Keep the **raw Zoho public link** (proven, whitelisted today,
zero new whitelisting dependency) as the default "Button A" per `04`/`07`. Offer the
branded-embed page only as an **opt-in, post-whitelisting upgrade** once `swenlly.com` (and
separately, the embed subdomain) are confirmed whitelisted for a given filter vendor — this
matches the "optional domain upgrade" model `04` already describes, just naming the embed
page as one of the things that upgrade unlocks, not something available by default.

**1d. Faster / self-hosted alternatives to Zoho's embed**

Self-hosted or CDN video platforms (Cloudflare Stream, Mux, Bunny Stream, Vimeo Advanced) all
support domain-restricted embeds, signed URLs, and branded/chromeless players, and are
materially faster than Zoho's viewer ([Mux vs Cloudflare Stream vs Bunny — 2026 comparison](https://www.pkgpulse.com/guides/mux-vs-cloudflare-stream-vs-bunny-stream-video-cdn-2026);
[Best Cloudflare Stream Alternatives 2026](https://www.buildmvpfast.com/alternatives/cloudflare-stream)).
**None of that matters for the filter problem**: swapping Zoho for Cloudflare Stream or Mux
trades one whitelisting dependency for another — `videodelivery.net`/`cloudflarestream.com` or
`stream.mux.com` are exactly as unwhitelisted-by-default as any other non-Zoho domain, and
getting a filter vendor to whitelist a generic CDN domain shared across thousands of unrelated
customers is realistically *harder* than getting them to whitelist a single dedicated
`swenlly.com`, precisely because a shared CDN domain can't be vetted "this domain = this one
business" the way NetFree/Rimon's manual review model wants. **The one dimension where a
self-hosted player wins is speed/UX after whitelisting is secured** — not feasibility of
getting whitelisted in the first place. This reframes `04`'s "domain we help get whitelisted"
option: whichever domain gets whitelisted (ours or a CDN's), the whitelisting process itself is
the bottleneck, and it is identical effort regardless of which video backend sits behind it.

---

## Question 2 — Can files live on the customer's own account instead of ours?

### Verdict: **BUILDABLE-WITH-CAVEAT** for both providers; recommended as an **opt-in tier**, not the default

**2a. Google Drive — customer's own account via OAuth**

Buildable, and — better than `03`'s security review anticipated — **it can likely avoid the
CASA burden entirely**, if scoped correctly:

- Google Drive's `drive.file` scope is **non-sensitive**: no security review, no CASA, and
  Google explicitly recommends it as the default over broader `drive`/`drive.readonly` scopes
  ([Google — Choose Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth);
  [GitHub issue — replace drive.readonly with drive.file to avoid verification](https://github.com/Jose-cd/React-google-drive-picker/issues/79)).
- The catch: `drive.file` grants access **only to files the app itself created or the user
  explicitly opened via Picker** — not arbitrary pre-existing files in the customer's Drive
  ([Google Drive API scopes guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)).
  For this product that catch is **not a problem**: the customer's files enter the system by
  *uploading them through our app*, which means our app is the creator of record for every
  file it touches — squarely inside `drive.file`'s per-file grant. `permissions.create` (the
  private-share call `07` already validated against the central account) operates per-file and
  works identically against app-created files under a customer's own OAuth grant
  ([Drive API — permissions.create](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create);
  [Drive API — share files/folders](https://developers.google.com/workspace/drive/api/guides/manage-sharing)).
- **Net: a "connect your own Google Drive" tier scoped to `drive.file` does NOT require CASA
  and does NOT reopen the full-inbox-equivalent blast radius `03` warned about for Gmail
  scopes** — that risk was specifically about *mailbox-read* scopes (`gmail.metadata` and
  above), which this feature doesn't need at all; storing/sharing files is a Drive-scope
  question, orthogonal to the Gmail-inbox-watching question `03` was analyzing. This is worth
  flagging back to appsec-engineer as a scope clarification, not a re-open of `03`'s verdict.
- **What it does re-introduce:** the customer's own ~350-share ceiling (per `07`, an
  undocumented anti-abuse velocity trigger) becomes *their* problem to hit and *our* auto-
  duplicate-and-reshare logic must run per-customer-account instead of once centrally — same
  mechanism, N times the operational surface (N customers × their own quota state to track).
  It also means **per-customer OAuth token storage** — smaller blast radius per breach (one
  customer's Drive, not the platform's central library) but *more* tokens to secure, rotate,
  and handle on disconnect, which `03`'s token-store hardening guidance (KMS envelope
  encryption, rotation, anomaly alerting) then applies per-tenant rather than once.

**2b. Zoho WorkDrive — customer's own account via OAuth**

Same shape, buildable: Zoho's standard OAuth 2.0 flow issues per-user access/refresh tokens
scoped to specific WorkDrive permissions (`WorkDrive.files.CREATE`, `.READ`, `.UPDATE`,
`.teamfolders.READ`, etc. — exact catalog needs a live-docs confirmation, blocked by the same
egress issue noted above) ([Zoho — OAuth 2.0 introduction](https://www.zoho.com/accounts/protocol/oauth.html);
[Zoho — Register your app](https://www.zoho.com/accounts/protocol/oauth-setup.html)). Once a
customer authorizes, `POST /api/v1/links` (the same external-link-creation call `07` already
validated for the central account) can be invoked with the customer's token to create the
public link inside *their* WorkDrive, not ours
([WorkDrive API — links](https://help.zoho.com/portal/en/community/topic/public-links-for-workdrive-files)).
**Two open items carried over from `07` and not resolved by this spike** (same doc-fetch
block): (1) whether a **free/Essentials-tier** Zoho account exposes the WorkDrive API at all —
if it doesn't, "customer's own account" for this path means *their* account must be on a paid
WorkDrive plan, a real adoption-friction cost to weigh; (2) the exact OAuth scope list, which
matters for how narrowly we can request access (narrower scope = less customer hesitation at
the consent screen, similar spirit to Google's `drive.file` preference).

**2c. Tradeoffs — central account (default) vs. customer's own account (opt-in)**

| Dimension | Central account (recommended default) | Customer's own account (opt-in) |
|---|---|---|
| Share-limit ceiling | Shared across all customers on one account; our reactive-duplicate logic runs once, centrally | Each customer has their own ceiling; duplicate/reshare logic must run per-tenant |
| Branding | Files show as shared "from Swenlly" (or from whatever central account name we set) | Files show as shared from the customer's own name/domain — better for power users who want it not to look third-party |
| Cost | One Drive/WorkDrive plan sized for aggregate storage/quota across all customers | Each customer supplies their own storage/quota; may reduce our storage cost at scale but pushes plan-tier cost onto them (esp. Zoho API-gated plans) |
| OAuth/security burden | Zero customer-facing OAuth; no per-tenant token store (matches `03`'s "avoid mailbox OAuth" spirit, applied here to Drive/WorkDrive OAuth too) | Per-customer OAuth consent, per-customer token storage/rotation/revocation-on-disconnect; smaller blast radius per breach, larger aggregate attack surface |
| Setup friction for customer | None — works immediately | Customer must run an OAuth consent flow, and for Zoho possibly hold a paid plan |
| CASA/verification | None (central account is our own, not subject to per-user consent-screen scope tiers) | Google side: avoidable via `drive.file` (no CASA) if the flow only ever touches app-created files; Zoho side: standard OAuth, no CASA-equivalent regime found in this spike |

**Recommendation:** keep **central account as the default** for both Drive and WorkDrive — it
matches `07`'s existing "no per-customer Google OAuth" verdict, keeps setup frictionless, and
keeps the share-quota and token-security surface concentrated and easier to operate. Offer
**"connect your own Drive/WorkDrive" as an opt-in power-user tier**, positioned for customers
who want their own branding on the share, have outgrown the shared account's aggregate quota,
or specifically don't want their files stored in Swenlly's central library. Scope the Google
side to `drive.file` specifically to keep it CASA-free — this should be called out as a hard
implementation constraint (never request broader Drive scopes for this tier), not just a
preference.

---

## Verdict summary

| Item | Verdict | Key fact / risk |
|---|---|---|
| Zoho WorkDrive iframe embed exists | ✅ BUILDABLE | `New embed code` action, iframe against `workdrive.zohoexternal.com/embed/<token>` |
| White-label page works for filtered recipients by default | ❌ BLOCKED (until whitelisted) | Filters gate at domain level before the page loads; an unwhitelisted `swenlly.com` never renders, iframe or not — **`swenlly.com` must be submitted for filter-vendor whitelisting** |
| Embed subdomain is the same domain already whitelisted for the raw link | ⚠️ UNCONFIRMED — likely NO | Raw public link tested by founder lives on `workdrive.zoho.com`; embed `src` is `workdrive.zohoexternal.com` — a second whitelisting request may be needed even after `swenlly.com` is approved. **Live-test before committing.** |
| Self-hosted/CDN embed as a faster alternative | BUILDABLE-WITH-CAVEAT | Faster after whitelisting; equally hard (arguably harder, being a shared multi-tenant CDN domain) to get whitelisted in the first place — doesn't change the core dependency |
| Google Drive: customer's own account via OAuth | ✅ BUILDABLE-WITH-CAVEAT | `drive.file` scope avoids CASA for app-created files; re-introduces per-customer share-ceiling and per-tenant token custody |
| Zoho WorkDrive: customer's own account via OAuth | ✅ BUILDABLE-WITH-CAVEAT | Standard OAuth flow exists; open questions on exact scope catalog and whether free/Essentials plans expose the API (same gap `07` already flagged) |
| Recommended file-ownership default | Central account (both providers), customer's-own as opt-in power-user tier | Matches `07`'s existing no-per-customer-OAuth default; opt-in tier solves branding/quota for power users without adding friction/risk for everyone |

## Sources
- [Zoho WorkDrive — Create and manage embed code (video)](https://www.zoho.com/workdrive/videos/share-files-and-folders/create-and-manage-embed-code.html)
- [Zoho Learn — Embed code from Zoho WorkDrive](https://help.zoho.com/portal/en/kb/zoho-learn/knowledge/editor/articles/embedd)
- [Zoho — Embedding video and PDF files into KB articles from WorkDrive](https://help.zoho.com/portal/en-gb/community/topic/embedding-video-and-pdf-files-into-kb-articles-from-workdrive)
- [KosherSignal — Kosher Web Filter: How It Works](https://koshersignal.com/blogs/articles/kosher-web-filter-guide)
- [Vice — Kosher Internet: A Niche, But Necessary Market for Ultra-Orthodox Jews](https://www.vice.com/en/article/kosher-internet-filters/)
- [Tech Kosher — NetFree overview](https://techkosher.org/netfree/)
- [Zoho WorkDrive — Public links for WorkDrive files (community)](https://help.zoho.com/portal/en/community/topic/public-links-for-workdrive-files)
- [Zoho WorkDrive — external sharing overview](https://www.zoho.com/workdrive/external-sharing.html)
- [Mux vs Cloudflare Stream vs Bunny Stream 2026](https://www.pkgpulse.com/guides/mux-vs-cloudflare-stream-vs-bunny-stream-video-cdn-2026)
- [Best Cloudflare Stream Alternatives 2026](https://www.buildmvpfast.com/alternatives/cloudflare-stream)
- [Google — Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Drive API — permissions.create](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create)
- [Google Drive API — Share files, folders, and drives](https://developers.google.com/workspace/drive/api/guides/manage-sharing)
- [GitHub — Replace drive.readonly with drive.file to avoid Google verification requirements](https://github.com/Jose-cd/React-google-drive-picker/issues/79)
- [Zoho — OAuth 2.0 Introduction](https://www.zoho.com/accounts/protocol/oauth.html)
- [Zoho — Register Your App (OAuth setup)](https://www.zoho.com/accounts/protocol/oauth-setup.html)
- [DeepStrike — Google CASA Security Assessment 2026](https://deepstrike.io/blog/google-casa-security-assessment-2025)

## What was not verified (needs a live-account check, not a build blocker)
1. Open a `workdrive.zohoexternal.com/embed/...` URL from an actual NetFree/Rimon-filtered
   device/connection to confirm whether that subdomain independently passes or fails today.
2. Confirm whether Zoho's free/Essentials WorkDrive plan exposes the API needed for
   `POST /api/v1/links` under a customer's own OAuth grant (same open item as `07`).
3. Pull the authoritative WorkDrive OAuth scope list from `workdrive.zoho.com/apidocs` (blocked
   here by network egress) to confirm the minimal scope for customer-side link creation.
