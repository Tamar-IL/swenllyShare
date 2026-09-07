# Refined Problem Model (from founder, 2026-09-07)

The founder ran the real-filter spike and corrected the model. This supersedes the
audience/delivery assumptions in the earlier docs where they differ.

## Two distinct blocked audiences (they need DIFFERENT delivery)

| Audience | Can open | Cannot open | File delivery that works |
|---|---|---|---|
| **Email-only** (Google services only: Gmail/Drive; no general web/links) | Email, Google Drive | any external/non-Google link | **Private Google Drive share** (opened inside Drive) |
| **Filtered internet** (NetFree/Rimon/Netspark) | Email + whitelisted sites | most public links | **Zoho WorkDrive public link** — the ONE public-link type whitelisted in NetFree |

**Filter spike result:** emails arrive fine and *some* links open, most are blocked — confirms
email is the reliable channel and link support is audience-specific.

## The two automations the product must do natively (replacing Make/Integromat today)

### 1. Auto-join (subscribe)
- Customer connects their **Google account** (OAuth) → system monitors the mailbox → a sender
  who emails "add me" is auto-added. This is a wanted core feature.
- **Safety/legal (kept):** least-privilege Gmail scope; auto-add → **reply-to-confirm double
  opt-in** + consent log (Israeli spam law, ₪1,000/msg). Never blast before confirm.

### 2. Auto-share (files) — system generates **two buttons per file**
- **Button A — Zoho WorkDrive public link** (for filtered-internet users). Zoho is the only
  public link that passes NetFree; it is slow but it works. NOT replaced by S3/R2 (those
  domains aren't whitelisted). Speed is secondary to passing the filter.
- **Button B — "request by email"** (for email-only users): opens a pre-filled email; when it
  arrives, the system **auto private-shares** the file with the sender via Google Drive.
- **350-share limit:** Google Drive caps private sharing (~350/file). After ~340 shares the
  engine must **auto-duplicate the file and swap in the new file ID**, transparently.
- **Safety:** file is shared with the *requesting sender's own address*, so a forged request
  can't steal someone else's file — main risk is spam/abuse → rate-limit per sender/file.

## File-size reality
- **Direct email attachment:** small files only (~≤20–25MB; filters may cap lower).
- **Large files:** Zoho public link (filtered users) or private Drive share (email-only w/
  Google) — both handle any size. **The one real gap:** large file + recipient with *no Google
  account at all* → only small attachments possible. Small slice; not an MVP blocker.

## Domain — confirmed model
- **Default: no domain.** Send as owner's Gmail; deliver via Zoho/Drive/attachment.
- **Optional upgrade** ("a domain for those who want"): a customer wanting faster-than-Zoho
  delivery or their own branding adds a domain we help get whitelisted. Post-MVP.

## Open feasibility question (next spike) → API automation
Can these be driven by API without the user touching Make?
1. **Google:** watch inbox (Gmail API), private-share a Drive file to an email, detect/handle
   the ~350 limit, auto-duplicate + re-share.
2. **Zoho WorkDrive:** create a public/embed link for an uploaded file via API; upload files.
3. The end-to-end "inbound request email → verify sender → share correct file → reply" loop.
