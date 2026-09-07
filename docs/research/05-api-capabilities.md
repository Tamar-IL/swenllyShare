# API Capabilities Spike — Hard Facts (2026-09-07)

**Purpose:** verify, with primary/official sources where reachable, whether the refined
model in `04-refined-problem-model.md` is buildable via API. This is a research-only
spike — no code was written.

**Methodology note (read this first):** `WebFetch` to primary vendor doc domains
(developers.google.com, workdrive.zoho.com, mailgun.com, support.google.com, etc.) was
**blocked by this session's network egress policy** for every domain tried, including
`example.com` (control test) — this is a session-level restriction, not a per-site
block. All findings below come from `WebSearch` result snippets, which quote or
paraphrase the official pages (Google's own developer docs, Zoho's own community/API
docs, Mailgun's own release notes, AWS's own SES docs, etc.) plus corroborating
secondary sources. Every number below is cross-referenced against ≥2 independent
sources where possible. Anything I could not corroborate is explicitly flagged
**UNCONFIRMED — verify with a live sandbox call before committing to the number.**

---

## 1. Google Drive API — private sharing from a central account

**Verdict: BUILDABLE-WITH-CAVEAT**

- **Programmatic private share to an arbitrary email:** Yes. `permissions.create` with
  `type: "user"`, `role: "reader"`, `emailAddress: "<any address>"` works from a central
  Google account (personal or Workspace) via a service account or OAuth client with the
  `drive` scope. This is standard, documented Drive API behavior — not in question.
  [Google Drive API — Manage sharing](https://developers.google.com/workspace/drive/api/guides/manage-sharing) (per search snippets).

- **Does the recipient need a Google account?** Effectively softening, but not zero-friction:
  - Historically: yes, a Google Account tied to that email was required to open a
    privately-shared (non-link) file.
  - Current (2025–2026) mechanism: **Visitor sharing** lets a non-Google-account
    recipient open the file after an **email PIN/OTP verification**, valid for **7 days**
    per verification, then they must re-verify. [Google Drive Help — Share documents with visitors](https://support.google.com/drive/answer/9195194) /
    [Share files with non-Google Accounts](https://support.google.com/drive/answer/6033939).
  - This is admin-controlled at the Workspace org level (an admin can enable/disable
    visitor sharing org-wide) — if the central account is a **personal** Google account
    rather than Workspace, confirm visitor sharing is on by default before relying on it.
    **UNCONFIRMED for personal (non-Workspace) accounts — verify live.**
  - Net effect: the founder's original assumption ("no Google account = fully blocked")
    is **not quite right** — it's friction (OTP every 7 days), not a hard block. Still
    real friction for a "click and open" UX goal.

- **Real per-file and per-day limits — the numbers do NOT cleanly match the founder's
  observed ~350/file:**
  - Multiple secondary sources (repeating what appears to be the official
    [Drive API usage-limits page](https://developers.google.com/workspace/drive/api/guides/limits))
    state a file can be **directly shared with up to 100 users/groups**, and Shared-Drive
    permission grants specifically cap at **100 groups per file in a shared drive**.
  - A separate, commonly cited number is **up to 1,500 sharing-invitation
    notifications/day** per account — this is a notification-email cap, not the same
    thing as a permission-count cap.
  - **Google does not publish an exact "hard" per-file permission ceiling for abuse
    detection** — the "Sorry, you have exceeded your sharing quota" error is explicitly
    described (in Google's own support content) as an **undocumented, reputation- and
    velocity-based anti-abuse trigger**, not a fixed number. This is consistent with the
    founder hitting ~350 in practice: the real ceiling for a given account is not the
    documented "100" — it's a soft, opaque threshold that commonly lands somewhere in
    the 300–600 range for many real accounts, per community reports. **Treat "100" as
    the documented/conservative number and ~350 (founder's real number) as the
    empirically-observed one for this specific account; do not hard-code either — detect
    the `sharingRateLimitExceeded`-class error and react, don't pre-guess a threshold.**
  - **"Copy file → new ID → re-share" workaround:** this is the correct approach and is
    exactly what the founder's model already proposes. It is a community-standard
    practice (not officially blessed by Google, but functionally sound because a new
    file ID starts with a fresh permission list) — the [`files.copy`](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
    method plus re-issuing `permissions.create` calls on the new ID is the standard
    pattern. Google support explicitly recommends "reduce sharing reach" and "spread
    sharing over 24h" as the sanctioned mitigations, which validates duplication +
    pacing as the resilient design (don't just duplicate once and blast all 350 shares
    again instantly — pace the re-share, too, to avoid re-triggering the velocity
    trigger on the new file).

- **Workspace plan needed?** No specific paid Workspace edition is required just to call
  `permissions.create` — a regular Google Cloud project with the Drive API enabled and
  either OAuth-user or service-account credentials against a personal Gmail account
  works. A **Workspace** account is recommended (not required) because: (a) it gives
  admin-console visibility/control over the visitor-sharing toggle, (b) Workspace
  accounts generally get a materially higher soft-abuse-detection ceiling than free
  personal accounts (per multiple community reports — **UNCONFIRMED precise number**),
  and (c) higher underlying API request-quota tiers. For an MVP tolerant of some early
  friction, a personal account can be piloted first; budget for a Workspace upgrade once
  volume is real.

**Bottom line:** the design is sound. The one thing to fix in the plan: don't hard-code
"350" as a threshold to duplicate at — catch the actual API error and duplicate
reactively, with paced re-sharing on the new file.

---

## 2. Zoho WorkDrive API — programmatic public links

**Verdict: BUILDABLE, with UNCONFIRMED plan/rate-limit specifics — verify live before commit**

- **Upload file via API:** Yes — WorkDrive's REST API supports file upload, including a
  chunked/resumable upload session flow for larger files.
  [Zoho WorkDrive API docs](https://workdrive.zoho.com/apidocs/v1/) (per search snippets;
  could not fetch this domain directly this session — egress-blocked).

- **Create an external/public share link via API:** Yes. The endpoint is
  `POST https://workdrive.zoho.com/api/v1/links` (a `.com.au` variant exists for the AU
  data center), JSON:API-compliant (requires `Accept: application/vnd.api+json` or you
  get a 415). Body uses a `type`/`attributes` JSON:API envelope with attributes:
  `resource_id` (file or folder ID), `link_name`, `allow_download` (bool),
  `request_user_data` (bool — whether the external visitor must fill in name/email
  before viewing), and `role_id` (permission level, e.g. `"7"` for a specific role — the
  exact role-ID-to-permission mapping is **UNCONFIRMED**, get it from a live API call or
  the WorkDrive API console). Source pattern corroborated by a public Deluge-script
  reference implementation and Zoho's own community threads referencing
  `/apidocs/v1/externalsharing/createsharelink`.

- **Plan/cost required:** **UNCONFIRMED — this is the single most important thing to
  verify before committing engineering time.** There is an open, apparently unresolved
  question on Zoho's own community forum ("Is Zoho WorkDrive API locked behind a
  paywall?") asking exactly whether the free **Essentials** plan gets API access or
  whether a paid **Starter/Team/Business** plan is required. Search results did not
  surface Zoho's answer. **Action: create a WorkDrive trial account and attempt an
  authenticated API call before scoping cost.**

- **Rate/link limits:** **UNCONFIRMED.** No official per-minute/per-day API rate limit
  or per-account link-count cap for WorkDrive specifically was found in this pass
  (Zoho publishes rate limits for CRM, Analytics, Payments APIs, but WorkDrive's own
  published rate-limit page was not surfaced by search and its domain was
  egress-blocked for direct fetch). Get this from Zoho support or the live
  `apidocs.zoho.com` portal before assuming any particular throughput.

- **Why this path matters despite being slow:** consistent with the founder's model —
  Zoho public links are reported as the one public-link type that passes NetFree,
  unlike S3/R2/custom-domain links. This spike did not independently re-verify the
  NetFree whitelist claim (that was the founder's own filter-spike result, taken as
  given per the brief).

**Bottom line:** the API shape (upload + create-external-link) exists and looks
straightforward. The one open fork that could change cost/timeline: confirm whether API
access needs a paid plan. Don't build against this until that's answered.

---

## 3. Dedicated-address inbound on our own domain

**Verdict: BUILDABLE overall — but not all six options are equal; one is effectively
BLOCKED for the specific anti-spoofing requirement.**

All six require owning/verifying our domain's DNS (MX, SPF, DKIM, DMARC records) — confirmed, no exceptions found.

| Option | Per-customer address | Auth result (SPF/DKIM/DMARC) exposed? | Cost | Verdict |
|---|---|---|---|---|
| **Mailgun Routes** | One wildcard/regex Route (e.g. match `.*@in.ourdomain.com`) can route many recipient-local-parts to one webhook — no need for one Route per customer. Free tier is capped at **1 inbound route**, which is enough since it's wildcard-based; paid Basic ($15/mo) gives 5 routes for redundancy/segmentation. | **Yes — explicitly.** Mailgun's own 2026 release note: *"Authentication results now included in inbound route URL posts"* — SPF/DKIM/DMARC pass/fail now arrives in the same webhook payload, no extra lookup needed. This is a recent, explicit, first-party feature — the strongest confirmation among the six options. | Free tier ~100 msgs/day; Basic $15/mo, Foundation $35/mo, Scale $90/mo (2026 pricing, per third-party trackers — **cross-check against mailgun.com/pricing directly**, egress-blocked this session). | **BUILDABLE — best fit.** |
| **SendGrid Inbound Parse** | Same wildcard-MX pattern works. | DKIM/SPF fields exist in the multipart payload but are, per a live GitHub issue against SendGrid's own docs repo, **under-documented/inconsistently surfaced** ("inbound parse webhook missing information"). Usable, but expect to reverse-engineer field names rather than rely on documented ones. | SendGrid's permanent free tier was replaced by a 60-day trial (100/day) in 2025; paid starts at Essentials ~$19.95/mo. | **BUILDABLE-WITH-CAVEAT** — works, but the auth-result contract is weaker/less documented than Mailgun's. |
| **Postmark Inbound** | Wildcard inbound domain supported (per Postmark's own inbound docs). | Postmark parses full raw MIME, so the standard `Authentication-Results` header should be present in the parsed headers array — but the exact JSON field/shape was **not independently confirmed this session** (docs domain reachable via search only, not fetchable). **UNCONFIRMED — verify against a live test message before relying on it.** | No free tier (60-day trial only); paid from ~$19.95-ish/mo bracket (unverified this pass — SES/Postmark/Resend/Brevo pricing verified more thoroughly in §4 below, inbound-specific Postmark pricing not separately re-verified here). | **BUILDABLE, pending field-shape confirmation.** |
| **CloudMailin** | Supports catch-all/wildcard addressing. | **Yes.** CloudMailin returns a structured `envelope` object in the JSON payload with SPF result and a DKIM object (`success` boolean + array of per-signature results, since a message can carry multiple DKIM signatures). Note: DKIM verification is flagged by CloudMailin as an **"experimental feature, available on request"** — confirm it's enabled on your account before depending on it. | Not independently verified this session (pricing page domain not fetchable). | **BUILDABLE-WITH-CAVEAT** (DKIM result is opt-in/experimental). |
| **Cloudflare Email Routing + Workers** | Wildcard/catch-all routing to a Worker is supported, incl. plus-addressing/subdomain patterns per Cloudflare's own community docs. | **Effectively BLOCKED for this use case.** A currently-open GitHub issue against Cloudflare's own `workerd` repo (#6740) states inbound mail delivered to a Worker's `email()` handler **lacks an `Authentication-Results` header entirely**, and the `ARC-Authentication-Results` header it does get contains only `arc=none` with **no spf=/dkim=/dmarc= verdict fields** — i.e., Cloudflare enforces "must have valid SPF or DKIM to be forwarded at all" (a July 2025 policy change) but does **not** tell your code *which* protocol passed or failed, or DMARC alignment. You'd have to re-implement SPF/DKIM/DMARC verification yourself against the raw message inside the Worker to get an actual anti-spoofing signal — defeating the point of using a managed inbound service. | Free (Cloudflare Email Routing itself has no charge; Workers has its own separate free tier). | **BLOCKED for the anti-spoofing requirement specifically** — inbound routing itself works, but do not rely on Cloudflare for the auth-result signal this design needs. |
| **Plain catch-all mailbox + IMAP** | Standard catch-all/wildcard-alias feature, supported by most mail hosts (Fastmail, mailbox.org, Zoho Mail, Postfix, etc.) and by plus-addressing as a fallback. | **Not exposed as structured data — DIY only.** A catch-all inbox just gets you the raw RFC 5322 message; if the *receiving* mail server itself performs SPF/DKIM/DMARC checks it may stamp its own `Authentication-Results:` header (mail-host-dependent, not guaranteed), and you'd parse that header yourself with no vendor SDK/webhook contract. Most fragile of the six for this specific requirement. | Usually cheapest (bundled with normal mailbox hosting). | **BUILDABLE-WITH-CAVEAT** — works, but is the most manual/least reliable path for the SPF/DKIM/DMARC signal the design depends on for anti-spoofing. |

**Recommendation:** Mailgun Routes is the strongest fit — the only option with an
explicit, first-party, documented "auth results in the webhook payload" feature as of
2026. SendGrid/Postmark/CloudMailin are workable fallbacks with more DIY verification.
Cloudflare should be avoided specifically for the auth-result requirement (routing
itself is fine, the signal isn't there). Plain IMAP catch-all is the most manual.

---

## 4. Outbound sending from our domain

**Verdict: BUILDABLE — SES is the cost leader, Brevo is the best free-tier fit for a
marketing product, Postmark carries a policy caveat for this specific use case.**

| Provider | Free tier | Paid economics | DKIM/SPF/DMARC on own domain | Notable catch |
|---|---|---|---|---|
| **Amazon SES** | 3,000 msgs/mo free for the first 12 months on new AWS accounts (accounts created after July 15, 2025 instead get a general $200 AWS credit, not the SES-specific free tier — **confirm which regime applies before budgeting**). | **$0.10 per 1,000 emails** at scale — cheapest option by a wide margin (~6x cheaper than Resend at 1M/mo per one comparison). | Full support via **Easy DKIM** (SES auto-manages DKIM key rotation) or Bring-Your-Own-DKIM; SPF/DMARC set up manually on the domain's DNS. | Starts in **sandbox mode**: can only send to *verified* recipient addresses until you **request production access** (a written form explaining volume/list-hygiene/bounce-handling; approval typically 24–48h). Most DIY of the four — no built-in dashboard/activity feed; you wire CloudWatch/SNS yourself for bounce/complaint handling. |
| **Postmark** | **None** as of 2025 — 60-day trial capped at 100/day, then mandatory paid plan from ~$19.95/mo. | Higher per-email cost than SES (~$15/mo + $1.80/1K beyond included volume per one source). | Full support, plus a custom Return-Path for DMARC alignment. | **Policy caveat specific to this product:** Postmark spent its first decade as transactional-only and only added a separate **Broadcast Message Stream** for bulk/marketing mail around 2020 — mixing marketing sends into a *Transactional* stream risks reputation/account action. Since this platform IS a marketing tool, using Postmark means deliberately provisioning email through a Broadcast stream, not the default transactional one — a configuration detail to get right, not a blocker, but worth flagging since it's easy to set up wrong. |
| **Resend** | **3,000 emails/month**, capped at **100/day**, **1 custom domain** on the free tier. | Scales up from there; a comparison source put ~$600/mo at 1M emails/mo (pricier than SES at volume). | DKIM/SPF/DMARC included at every tier, including free. | Modern, simple API; good for MVP/dev testing, but the 100/day free cap is tight for a live customer's list. |
| **Brevo** (formerly Sendinblue) | **300 emails/day**, no monthly cap (~9,000/mo effective), full transactional API + webhooks on free, no expiration. | Contact-count-based tiers beyond free; as of late 2025 even entry paid tiers (Starter/Standard) got contact-count caps. | Full SPF/DKIM/DMARC setup via dashboard (domain authentication flow generates the TXT records for you). | Brevo's own logo is stamped into free-tier emails; automations capped at 2,000 contacts total across all active automations on free. Brevo is explicitly built for marketing-style sending (unlike Postmark), so it's the most policy-aligned free option for this product's actual use case. |

**Recommendation:** Prototype on **Resend or Brevo free tier** (Brevo's daily-not-monthly
cap and marketing-friendly ToS posture fit this product's actual use case better than
Postmark's transactional-first culture); move to **SES** once volume/cost matters, and
budget the 24–48h production-access approval lag into any launch timeline. All four are
categorically better than "send as the owner's Gmail" — Gmail SMTP has no way to
establish SPF/DKIM/DMARC alignment for *our* domain, caps out at ~500/day, and puts the
founder's personal account reputation at risk; any of these four gives real domain-level
authentication instead.

---

## Open items to close before committing engineering time

1. **Zoho WorkDrive: does the API require a paid plan?** Unanswered on Zoho's own
   community forum as of this search. Spin up a trial account and make one authenticated
   API call — this is a 30-minute check that resolves the single biggest unknown in
   this whole document.
2. **Google Drive real per-file ceiling for the specific account you'll use** — don't
   trust "100" or "350" as a constant; instrument for the actual
   `sharingRateLimitExceeded`-class error and duplicate reactively.
3. **Postmark inbound webhook's exact JSON field for auth results** — confirm with one
   live test send before relying on it for anti-spoofing.
4. **Which SES free-tier regime applies** (pre- vs post-July-2025 AWS account) — check
   the AWS account's creation date against the cutover.
5. Everything flagged **UNCONFIRMED** above was blocked from direct primary-source
   verification this session by an environment-level egress restriction (WebFetch was
   blocked for every domain tested, including a neutral control). Re-run direct fetches
   against the primary docs (developers.google.com, workdrive.zoho.com/apidocs,
   mailgun.com/pricing, aws.amazon.com/ses/pricing) from an environment where that's
   available before finalizing cost/limit numbers in a spec.
