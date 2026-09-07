# Discovery Synthesis — Email Marketing for Filtered-Internet Users

**Stage:** Discovery gate (research only — nothing is built, no technology is locked).
**Inputs:** `01-product-discovery.md` (PM), `02-architecture-options.md` (Architect), `03-security-privacy-risks.md` (AppSec).
**Author:** Orchestrator, synthesizing the three parallel research passes.

---

## 1. The bet, in one sentence

**Email itself is the filter-proof transport** for the Israeli Haredi *kosher-filtered-internet* market, and this product automates **both directions of it** — inbound (people email to subscribe / to request a file) and outbound (broadcasts and file delivery that actually land inside the filter).

Every link-centric platform (Mailchimp, Brevo, MailerLite…) is *functionally broken* in this market: kosher filters (NetFree / Rimon / Netspark) whitelist domains, kill public links, and strip images. What survives the filter is **email and attachments**. That seam is the entire wedge.

## 2. Audience — confirmed

The "filtered internet" hunch was right: **Israeli Haredi filtered-internet users**. ~1.45M people (≈14% of Israel), the fastest-growing segment in the developed world, very young, and ~88% have a personal email — reportedly their best-performing digital channel *because it beats the filter*.
**Not greenfield:** a local competitor, **שלח מסר (Shlach Meser)**, already sells filter-visible 20MB file mailings. Differentiation (the automations + a trustworthy UX) matters.

## 3. The technical unlock (the thing to get excited about)

**An email attachment downloads *inside* the already-whitelisted webmail domain (gmail.com / outlook.com), so it bypasses the web whitelist entirely — filter-proof and instant.** This is *why* the product can work, and it beats Zoho WorkDrive outright (users report ~100–250 KB/s, and zoho.com may not even be whitelisted → blocked). So delivery is **size-tiered**:
- **≤ ~20 MB → email attachment** (no second fetch, filter-proof, instant).
- **Larger → a presigned link on a whitelisted delivery domain** (e.g. Cloudflare R2, $0 egress), submitted *once* to the filters' whitelists.

## 4. The three findings that shape the design (converged across researchers)

1. **Auto-file-share is a security landmine if it trusts the email `From:`** (AppSec, Critical). `From:` is trivially spoofable → a zero-auth path to steal someone's private file, plus request-bombing. **Mandatory controls before it ships:** verify **DMARC pass** on the inbound email + an owner-curated **allowlist**; for anyone not allowlisted, send a **single-use, time-limited signed link** (not a raw auto-attach); add per-sender/file rate limits + audit log.
2. **Auto-subscribe is a legal landmine** (PM + AppSec). Israel's spam law is opt-in with **₪1,000 per message** statutory damages, no proof of harm required. Defensible flow: the inbound "add me" email is the express consent → **reply-to-confirm (double opt-in)** → marketing only after confirmation → hard **consent log**. Never move a sender straight to the sendable list — forged sign-ups also poison deliverability for everyone on shared infra.
3. **Full-inbox OAuth is the wrong MVP path** (AppSec). Gmail restricted scopes pull in Google's **CASA** annual security audit (~$500–$75K/yr, recertified yearly) and make a breach expose the owner's *entire* inbox. **Use a dedicated forwarding address / plus-addressing / signature-verified inbound-parse instead**; full-inbox OAuth is a later, budgeted, opt-in power tier.

## 5. Recommended MVP thin-slice (open, not locked)

The smallest thing that proves the bet:
1. Connect the **owner's own, already-whitelisted mailbox** (Gmail API `watch` + Pub/Sub push for ~1–10s detection; IMAP IDLE as the portable fallback).
2. **Inbound-subscribe → reply-to-confirm double opt-in + consent log.**
3. **One image-light / link-light broadcast** sent *through that mailbox*.
4. **Small-file (≤20MB) request → verify (DMARC + allowlist/confirm) → auto-attach.**
5. A **legibility-first dashboard** so owners trust the "invisible magic."

**Deferred:** the embeddable public file view · large-file / Drive / R2 delivery · custom domain + DKIM + warmup · segmentation / A-B / analytics · full-inbox OAuth.

**The one number to prove before anything else:** *does a message actually land inside a real kosher filter?*

## 6. Decisions for the founder (genuine forks — your call)

1. **Sending model / volume.** Send *as the owner's own mailbox* (~500/day, no domain, simplest — the MVP assumption) **vs.** build our own whitelisted sending infrastructure (much bigger, needs a domain + ESP). **>300/day forces a domain + ESP.** What daily volume do real users need?
2. **The domain constraint.** You asked for "no custom domain." Honest finding: a real production path (deliverability + catch-all addressing + a whitelistable large-file domain) effectively needs **one ~$10 domain**. Hold the hard no-domain rule (caps the product at attachment-only, owner-mailbox sending) **or** accept a single cheap domain that unlocks the rest?
3. **Go/no-go spike first.** Before building, run **real test sends through an actual NetFree/Rimon filter** — the filters' whitelist SLA is currently *unverified* (their docs were egress-blocked during research). If domain-whitelisting is slow/unreliable, the large-file link path collapses and the product is capped to attachment-only. **This is the #1 risk and should be the first thing we test.**

## 6a. Founder decisions — LOCKED (2026-09-07)

- **Sending model:** send **as the owner's own already-whitelisted mailbox** (Gmail, ~500/day) for the MVP. No shared sending infra yet.
- **Domain:** **none required for the MVP** — the owner-mailbox model needs no domain to send, detect inbound, or deliver ≤20MB attachments. A single platform-owned domain is deferred to when large-file (>20MB) delivery or scaling past the mailbox limits is actually needed. Users never need their own domain.
- **Go/no-go spike:** approved. Founder has access to a real filtered device and will run the filter test (see `filter-spike/PROTOCOL.md`) **before** any build.

## 7. Recommended next steps

1. **Founder answers §6** (volume, domain, and approves the filter spike).
2. **Run the filter spike** (prove a broadcast + a 20MB attachment land inside NetFree/Rimon).
3. If the spike passes → stand up the team in this repo (`CLAUDE.md` + 22 agents) and write the PRD from this synthesis, then Design → Build the thin-slice.

> Nothing here is committed engineering — it's the evidence base for the next decision. See the three detailed docs alongside this file.
