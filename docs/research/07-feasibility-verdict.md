# Feasibility Verdict — GO to build (with 3 small live-checks)

Synthesis of the API-capability + integration-architecture spikes against the founder's
refined model. **Bottom line: every core piece is buildable; no blockers found.**

> Caveat carried from `05`: the researcher's direct doc-fetch was network-blocked, so facts
> come from cross-checked web sources, not primary fetches. Three items need a 30-minute
> live-account confirmation (below) — none is a blocker to starting.

## Verdict by capability

| Capability | Verdict | Key fact |
|---|---|---|
| Inbound per-customer address (our domain) | ✅ BUILDABLE | **Mailgun Routes** — one wildcard route covers all customer addresses and (2026) puts SPF/DKIM/DMARC results in the webhook (needed for anti-spoofing). Cloudflare Email Workers is out — no DMARC verdict. |
| Outbound from our domain | ✅ BUILDABLE | **Brevo** (300/day free, marketing-friendly) for the MVP; SES for scale later. All beat sending as the owner's Gmail (real SPF/DKIM/DMARC). |
| Private Drive share from our central account | ✅ BUILDABLE (caveat) | `permissions.create` to any email; recipient needs **no Google account** (visitor email-OTP, 7-day). The ~350 cap is an **undocumented anti-abuse velocity trigger** — so **detect the quota error and duplicate reactively**, don't hard-code a number. |
| Zoho WorkDrive public link via API | ✅ BUILDABLE (shape) | `POST /api/v1/links` (external link) + chunked upload exist. **Open:** does the free Essentials plan expose the API, or is a paid plan required? |
| No per-customer Google OAuth | ✅ CONFIRMED | Central file account + per-customer address ⇒ zero customer OAuth ⇒ no Google CASA audit, no whole-inbox risk. OAuth survives only as an opt-in "use your own Drive" tier. |

## Recommended default stack (open, not locked)

- **1 platform domain** · per-customer inbound addresses via **Mailgun Routes** (plus-token intent: `cust-<id>+subscribe@`, `cust-<id>+file-<token>@`).
- **Outbound:** Brevo (MVP) → SES (scale).
- **Files:** central Google Drive (private share) + central Zoho WorkDrive (public links); small files → direct attachment.
- **Data:** subscriber lists + consent log in our own DB (multi-tenant; address→tenant key; file-scoped shares).
- **Safety:** DMARC gate on inbound · double-opt-in confirm · per-sender/file rate limits · audit log.

## The 3 live-checks (do during P0, not blockers)
1. **Zoho:** does your current Zoho plan expose the WorkDrive API? (Founder already uses Zoho — quickest to answer.)
2. **Google:** confirm the real per-central-account share ceiling by testing the quota-error path (build reactive duplication regardless).
3. **Deliverability:** stand up SPF/DKIM/DMARC on the platform domain and test a real send into a filter early.

## Green light
The bet is validated (audience + filter spike), the model hangs together, and the stack is
buildable with no dead ends. **Ready to write the PRD and start the build** — thin-slice first:
per-customer address → auto-subscribe (double opt-in) → one image-light broadcast → file
auto-share (two buttons) → simple dashboard. Prove it end-to-end for one real customer.
