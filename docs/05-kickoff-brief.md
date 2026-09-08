# Kickoff Brief — Swenlly System 2 (File-Sharing Platform)

## The instruction
Build **Swenlly Share — the standalone filter-proof file-sharing product**, as specified in
`docs/01-prd-file-sharing.md`. Read first: `CLAUDE.md` → `docs/00-README.md` → this brief →
`docs/01-prd-file-sharing.md` → `docs/research/`.

**Not greenfield.** Discovery is complete and validated (audience, the founder's real filter
spike, and the API + white-label spikes). Build what's specified; if you think a decision is
wrong, **say so and wait** — don't silently build something else.

**Skip Steps 0–1 of the orchestration protocol.** Start at **Step 2 (Design gate)**:
product-designer + ui-visual-designer define the upload flow, the per-file settings, the two
link types, and the (flagged-off) branded embed page — then build to the acceptance criteria,
running the proof gates (QA, code-review, eval where automation output quality matters,
trust-safety + AI red team on the inbound-email/file-request attack surface, critic).

## Locked decisions (do not relitigate)
- **The bet & audience:** email is the filter-proof transport; two audiences (email-only →
  private Drive share; filtered-internet → Zoho public link). See `docs/research/04`.
- **Central accounts by default:** files in the platform's own Google Drive + Zoho WorkDrive;
  **no per-customer OAuth by default.** Customer's-own-account is an opt-in power tier — on
  Google use the `drive.file` scope (CASA-free). See `docs/research/07`, `08`.
- **Delivery lanes:** raw Zoho public link is the default distribution link (proven to pass
  NetFree). Small files → direct attachment. Reactive auto-duplication past the Drive share cap
  (the ~350 number is a fuzzy velocity trigger — detect the quota error, don't hard-code it).
- **White-label embed page:** the goal, but **behind a feature flag, default OFF** until
  `swenlly.com` AND Zoho's `zohoexternal` embed domain are whitelisted by the filters
  (`docs/research/08`). Never a launch precondition.
- **Consent/safety:** DMARC-verify every inbound file-request before sharing; share only to the
  verified sender's own address; rate-limit; audit log. Invariants in `docs/research/03` may
  only be made stricter.
- **Zoho:** founder holds a **paid Zoho plan** → WorkDrive API available.

## First P0 spikes (do early)
1. Confirm the Zoho WorkDrive API creates a public link + supports chunked upload on the paid plan.
2. Verify Google Drive visitor-sharing (no-Google-account open via email-OTP) on the chosen
   central account type; build reactive auto-duplication on the quota error.
3. Stand up per-file inbound addresses (Mailgun) with the DMARC result in the webhook; verify a
   real file-request → private share round-trip.
4. (When ready) the white-label whitelisting test: does a Zoho file/video render on a
   swenlly.com page inside a real filter?

## How to work
Plan your own sprints. One phase at a time; a phase is not "done" until you've **run it** and
shown it works. Commit + push after each chunk; append a 3-line note to `docs/progress.md`. Run
the proof gates before calling anything done.
## Design bar — NON-NEGOTIABLE (founder's top priority)

The UI/UX must be **world-class and international-standard.** This is the founder's #1 priority
— the team owns that bar and must not under-invest. Treat design as a first-class workstream,
not a finishing touch.

- **Design gate before engineering.** Deploy **product-designer + ui-visual-designer** first.
  Produce a real visual contract — `docs/03-design-language.md` + `docs/design-tokens.css`
  (color, type, spacing, radius, shadow, motion, components) — and validate it BEFORE building
  screens. Hold it to the standard of the Conductor's `docs/design-system.md`.
- **Hebrew-first & RTL-first.** This is a Hebrew product for an Israeli audience. RTL layout,
  Hebrew typography, and Hebrew copy are first-class from the first screen — never bolted on.
- **Audience-appropriate aesthetic.** Clean, calm, trustworthy, highly legible for a
  non-technical Haredi audience. Restraint over flash; the "invisible magic" must feel
  effortless and dependable. Light + dark, both first-class.
- **Accessibility (WCAG AA)** and **mobile-first responsiveness** are requirements, verified
  with a real audit (e.g. axe), not assumed.
- **The critic + a design-review gate check visual quality before anything ships.** A screen
  that isn't world-class fails the gate and gets redone.
