# Swenlly Share — Product Docs Index (System 2)

> **This repository = System 2: the standalone file-sharing product** (`docs/01`). System 1
> (the email-marketing platform) lives in the separate **`swenllyMailing`** repo. See
> `docs/05-kickoff-brief.md` to start the build.

**Swenlly Share** is a filter-proof file-distribution product for the Israeli Haredi
filtered-internet / email-only market, where kosher filters (NetFree / Rimon / Netspark)
whitelist domains, block public links, and where "email-only" users have no general web at all.
The bet (validated in Discovery): **email is the one transport that reliably passes the filter.**
A customer uploads a file once and gets: (a) a **distribution link** (the raw Zoho WorkDrive
public link by default — the one public link that passes NetFree), (b) a **mailto request link**
for email-only users (they email a per-file address → the system privately shares the file to
them, no Google account needed via email-OTP, or attaches it for small files), and (c) per-file
**settings** (custom send message, file name, expiry). A **Swenlly-branded embed page** is the
white-label goal, shipped behind a feature flag that stays OFF until `swenlly.com` (and Zoho's
`zohoexternal` embed domain) are whitelisted by the filters.

## Reading order
1. `00-README.md` (this file).
2. `05-kickoff-brief.md` — what to build, locked decisions, where to start.
3. `01-prd-file-sharing.md` — the PRD, with a testable acceptance criterion per requirement.
4. `docs/research/00`–`08` — the validated Discovery record (shared with System 1);
   `00` (synthesis), `04` (refined model), `06` (architecture), `07` (feasibility verdict),
   `08` (white-label + file ownership) are load-bearing.

## Precedence (which wins on conflict)
1. **`01-prd-file-sharing.md` wins over all research docs** — it's the committed product definition.
2. **Founder decisions (2026-09-07)** win over any research doc: platform owns one domain +
   per-customer/per-file inbound addresses (Mailgun); files in the platform's central Google
   Drive + Zoho WorkDrive (customer's-own-account is an opt-in power tier; Google `drive.file`
   scope avoids CASA); reactive auto-duplication past the Drive share cap; paid Zoho plan
   (WorkDrive API available); the branded embed page is gated on domain whitelisting.
3. **`06`/`07`/`08` win over `00`–`05`** on architecture, delivery lanes, and buildability.
4. **`03-security-privacy-risks.md` is authoritative for safety/consent controls** — a PRD may
   only make them stricter (DMARC gate on inbound triggers, share-to-verified-sender, rate
   limits, audit log).

**Unresolved items are carried as Open Questions in the PRD, never silently resolved.** The
quality gates check work against the PRD's **Acceptance Criteria**.
