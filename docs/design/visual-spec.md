# Visual Spec — Swenlly Share (System 2)

**Owner:** UI Visual Designer · **Date:** 2026-09-08
**Inputs:** PRD §2/§5, ux-brief.md (flows/screens fixed — this is the visual layer only).
**For:** frontend-engineer.

**Direction:** a calm, trustworthy utility — closer to a bank's document portal than a SaaS
dashboard. The audience is non-technical and trust-sensitive (brief §4: the audit log and expiry
chip *are* the trust mechanism). Generous whitespace, one sparing accent color, no gradients or
"modern SaaS" flourish, status always in color **+** text. Hebrew-first RTL native.

---

## 1. Tokens

### 1.1 Color — light (MVP)

```css
:root {
  --color-bg:            #FAFAF9;   /* page ground, warm off-white */
  --color-surface:       #FFFFFF;   /* cards, modals, inputs */
  --color-surface-sunken:#F2F1EF;   /* skeletons, disabled fields */
  --color-border:        #E4E1DC;
  --color-border-strong: #CFCBC3;
  --color-text:          #201D1A;   /* AA on bg: 15.1:1 */
  --color-text-muted:    #6B6560;   /* AA on bg: 4.7:1 */
  --color-text-faint:    #9B948C;   /* large text only */

  --color-brand:         #1E5F5A;   /* deep teal — primary actions + wordmark */
  --color-brand-hover:   #164A46;
  --color-brand-tint:    #E7F1F0;

  /* Link-type semantics — visually distinct, equal weight */
  --color-link-dist:       #1E5F5A; /* distribution — teal, brand family */
  --color-link-dist-tint:  #E7F1F0;
  --color-link-email:      #8A5A2B; /* email-request — amber-brown, matched weight */
  --color-link-email-tint: #F5EEE5;

  /* Status */
  --color-status-active:      #1E7A4C;
  --color-status-active-bg:   #E7F5EC;
  --color-status-expiring:    #A15C00; /* amber, darkened for AA on tint */
  --color-status-expiring-bg: #FBF0DC;
  --color-status-expired:     #6B6560; /* gray, not red — expiry is routine */
  --color-status-expired-bg:  #ECEAE7;
  --color-status-quarantined: #B3261E; /* red — reserved for security states */
  --color-status-quarantined-bg: #FBE9E8;
  --color-status-delivered:   #1E5F5A;
  --color-status-delivered-bg:#E7F1F0;

  --color-danger:        #B3261E;
  --color-danger-hover:  #8F1E18;
  --color-danger-tint:   #FBE9E8;
  --color-success:       #1E7A4C;
  --color-focus-ring:    #1E5F5A;

  --shadow-sm: 0 1px 2px rgba(32,29,26,0.06);
  --shadow-md: 0 4px 16px rgba(32,29,26,0.10);
  --shadow-modal: 0 12px 40px rgba(32,29,26,0.18);
}
```

**Contrast (AA: body 4.5:1 / large text 3:1):** `--color-text` on bg/surface 15.1:1;
`--color-text-muted` 4.7:1. Status colors are darkened to pass 4.5:1 on their own tint (amber
4.6:1, green 4.9:1, red 5.4:1) — don't swap in lighter "brand" hues for status text.

### 1.2 Dark theme (cheap subset — ship if trivial, not a blocker)

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-bg: #17181A; --color-surface: #1F2123; --color-surface-sunken: #26282A;
    --color-border: #34363A; --color-border-strong: #46484C;
    --color-text: #EDEBE7; --color-text-muted: #A8A39C; --color-text-faint: #77726B;
    --color-brand: #4FBDB3; --color-brand-hover: #6ECFC6; --color-brand-tint: #17332F;
    --color-link-dist: #4FBDB3; --color-link-dist-tint: #17332F;
    --color-link-email: #D69A5C; --color-link-email-tint: #332617;
    --color-status-active: #4ED28A; --color-status-active-bg: #17301F;
    --color-status-expiring: #E3A83B; --color-status-expiring-bg: #33280F;
    --color-status-expired: #A8A39C; --color-status-expired-bg: #26282A;
    --color-status-quarantined: #F2857D; --color-status-quarantined-bg: #331714;
    --color-status-delivered: #4FBDB3; --color-status-delivered-bg: #17332F;
    --color-danger: #F2857D; --color-danger-hover: #F7A69F; --color-danger-tint: #331714;
    --color-success: #4ED28A; --color-focus-ring: #4FBDB3;
  }
}
:root[data-theme="dark"] { /* same block, repeated so an explicit toggle wins */ }
```
`body { background: var(--color-bg); color: var(--color-text); }` — always explicit, never
transparent.

### 1.3 Typography

**Font stack** (Hebrew-first, good Latin rendering, real system fallback):
```css
--font-sans: "Assistant", "Heebo", -apple-system, "Segoe UI", "Arial Hebrew", sans-serif;
--font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace; /* tokens, dates in tables if needed */
```
Load **Assistant** from Google Fonts — clean humanist Hebrew glyphs at all weights below, matching
Latin for embedded URLs; `Heebo` as fallback web font, then system sans. Optional network loads;
fallback renders with no FOUT-sensitive layout (1.3.1).

```css
--fs-xs:   0.75rem;   /* 12px — timestamps, helper text */
--fs-sm:   0.875rem;  /* 14px — table rows, secondary labels */
--fs-base: 1rem;      /* 16px — body, inputs */
--fs-md:   1.125rem;  /* 18px — card titles, file names in list */
--fs-lg:   1.375rem;  /* 22px — section headers ("קישור להפצה") */
--fs-xl:   1.75rem;   /* 28px — page title (per-file file name) */
--fs-2xl:  2.25rem;   /* 36px — sign-in wordmark, empty-state headline */

--fw-regular: 400; --fw-medium: 500; --fw-semibold: 600; --fw-bold: 700;

--lh-tight: 1.25;  /* headings */
--lh-normal: 1.5;  /* body */
--lh-relaxed: 1.7; /* Hebrew paragraph copy — Hebrew niqqud-free text reads better slightly looser */
```
Weights: body 400, emphasis/labels 500, headings 600, wordmark 700. Never below 400 — thin/light
weights render poorly in Hebrew web fonts at small sizes.

**1.3.1 Font-loading guard:** `font-display: swap` on the Google Fonts `<link>`; Assistant/Heebo
and the system Hebrew fallback have close enough x-heights/line metrics that swap causes no
visible reflow — no loading-spinner gate needed.

### 1.4 Spacing, radius, layout

```css
--space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
--space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;

--radius-sm: 6px; --radius-md: 10px; --radius-lg: 16px; --radius-full: 999px;

--content-max: 720px;      /* per-file page, forms — readable Hebrew measure */
--content-max-wide: 960px; /* file list table */
--container-pad: var(--space-4);
```

**Breakpoints** (sender app desktop-first, embed page mobile-first — same tokens, per-screen
defaults noted below):
```css
--bp-sm: 480px;   /* embed page target */
--bp-md: 768px;   /* sender app collapse point */
--bp-lg: 1024px;  /* sender app desktop */
```
Single-column flow throughout — a form-and-list product, not a dashboard. Table/list container:
`--content-max-wide`, centered, `padding-inline: var(--container-pad)`.

---

## 2. RTL specifics (binding for every component below)

- `<html dir="rtl" lang="he">` at the root. Use **logical properties exclusively** —
  `margin-inline-start/end`, `padding-inline-start/end`, `inset-inline-start/end`,
  `border-inline-start`, `text-align: start/end`. Never `left`/`right`/`margin-left`.
- **Mirrored icons:** back chevron, upload arrow flip via
  `[dir="rtl"] .icon-mirror { transform: scaleX(-1); }`. Do **not** mirror: copy, trash, download,
  checkmark, close, clock.
- **LTR isolation:** every URL/email/mailto wraps in
  `<span dir="ltr" style="unicode-bidi: isolate;">…</span>` (class `.ltr-token`) — un-isolated it
  visually reorders and reads as garbled.
- Focus order follows RTL visual order — falls out of DOM order + logical properties; don't
  force tabindex.

---

## 3. Iconography

One inline-SVG icon set, 24×24 viewBox, 1.75px stroke, round joins/caps, no fill. Ship as one
`icons.svg` `<symbol>` sprite or inline; always paired with `aria-hidden="true"` +
`aria-label`.

1. `file` — generic document row
2. `file-video` — video file row
3. `upload-cloud` — dropzone idle (no mirror)
4. `copy` — copy-to-clipboard
5. `check` — copied/success confirmation
6. `download` — embed-page download CTA
7. `trash` — delete/revoke
8. `chevron-back` — "← חזרה לרשימה" (mirrors)
9. `clock` — expiry timing
10. `alert-circle` — errors, quarantine notices
11. `mail` — email-request link marker
12. `link` — distribution link marker

---

## 4. Components

### 4.1 Buttons
```css
.btn { height: 44px; padding-inline: var(--space-5); border-radius: var(--radius-sm);
  font-size: var(--fs-base); font-weight: var(--fw-semibold); line-height: 1;
  display: inline-flex; align-items: center; gap: var(--space-2); border: 1px solid transparent;
  cursor: pointer; transition: background-color .15s ease, border-color .15s ease; }
.btn-primary   { background: var(--color-brand); color: #FFFFFF; }
.btn-primary:hover  { background: var(--color-brand-hover); }
.btn-primary:disabled { background: var(--color-border-strong); color: var(--color-text-faint); cursor: not-allowed; }
.btn-secondary { background: var(--color-surface); color: var(--color-text); border-color: var(--color-border-strong); }
.btn-secondary:hover { background: var(--color-surface-sunken); }
.btn-destructive { background: var(--color-surface); color: var(--color-danger); border-color: var(--color-danger); }
.btn-destructive:hover { background: var(--color-danger-tint); }
.btn:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
```
44px height meets the brief's 44×44 tap-target minimum. Icon-only buttons (copy) are 44×44
square, icon centered, `aria-label` required.

### 4.2 Inputs
```css
.input { height: 44px; width: 100%; padding-inline: var(--space-3); border-radius: var(--radius-sm);
  border: 1px solid var(--color-border-strong); background: var(--color-surface);
  font-size: var(--fs-base); color: var(--color-text); text-align: start; }
.input:focus { outline: none; border-color: var(--color-brand); box-shadow: 0 0 0 3px var(--color-brand-tint); }
.input.has-error { border-color: var(--color-danger); }
.input-help { font-size: var(--fs-xs); color: var(--color-text-muted); margin-top: var(--space-1); }
.input-error-text { font-size: var(--fs-xs); color: var(--color-danger); margin-top: var(--space-1); }
```
Textarea: same treatment, `min-height: 88px`, `resize: vertical`.

### 4.3 Artifact card (the load-bearing component — 1.4 of the brief)
One card per link type, equal size/weight, distinguished only by icon + accent color:
```css
.artifact-card { background: var(--color-surface); border: 1px solid var(--color-border);
  border-inline-start: 3px solid var(--accent); /* --color-link-dist or --color-link-email, set per card */
  border-radius: var(--radius-md); padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); }
.artifact-card__label { font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--accent);
  display: flex; align-items: center; gap: var(--space-2); }
.artifact-card__value-row { display: flex; align-items: center; gap: var(--space-2);
  background: var(--tint); /* --color-link-dist-tint or --color-link-email-tint */
  border-radius: var(--radius-sm); padding: var(--space-3); }
.artifact-card__value { font-family: var(--font-mono); font-size: var(--fs-sm); flex: 1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } /* wrapped in .ltr-token span */
.artifact-card__explainer { font-size: var(--fs-sm); color: var(--color-text-muted); line-height: var(--lh-relaxed); }
```
Copy button: `.btn-secondary` 36×36 icon-only inside `.artifact-card__value-row`. On click: swap
icon `copy → check`, `aria-label` to "הועתק", revert after 2000ms; announce via a visually-hidden
`aria-live="polite"` region, not the toast system (keeps confirmation tied to the click).

**Disabled/expired:** `opacity: 0.6`, `--accent`/`--tint` swap to
`--color-status-expired`/`-bg`, copy disabled, explainer replaced with the expiry notice
(icon `alert-circle`, not `link`/`mail`).

### 4.4 Status pill
```css
.pill { display: inline-flex; align-items: center; gap: var(--space-1); height: 28px;
  padding-inline: var(--space-3); border-radius: var(--radius-full); font-size: var(--fs-xs);
  font-weight: var(--fw-semibold); }
.pill-active      { color: var(--color-status-active);      background: var(--color-status-active-bg); }
.pill-expiring    { color: var(--color-status-expiring);    background: var(--color-status-expiring-bg); }
.pill-expired     { color: var(--color-status-expired);     background: var(--color-status-expired-bg); }
.pill-quarantined { color: var(--color-status-quarantined); background: var(--color-status-quarantined-bg); }
.pill-delivered   { color: var(--color-status-delivered);   background: var(--color-status-delivered-bg); }
```
Every pill has a small solid dot (`::before`, 6px, currentColor) **plus** the status word — color
is never the sole signal.

### 4.5 Upload dropzone
```css
.dropzone { border: 2px dashed var(--color-border-strong); border-radius: var(--radius-md);
  background: var(--color-surface); padding: var(--space-8) var(--space-5); text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
  transition: border-color .15s ease, background-color .15s ease; }
.dropzone[data-state="drag-over"] { border-color: var(--color-brand); background: var(--color-brand-tint); }
.dropzone[data-state="uploading"] { border-style: solid; border-color: var(--color-border); cursor: default; }
.dropzone[data-state="error"]     { border-color: var(--color-danger); background: var(--color-danger-tint); }
```
- **Idle:** `upload-cloud` icon (40px), "גרור קובץ לכאן, או" text, `.btn-primary` "בחר קובץ
  מהמחשב" as a real `<label for="file-input">` (native picker always present). Size-limit line
  (`--fs-sm` muted) below.
- **Drag-over:** border/background swap only, no layout shift.
- **Uploading:** content replaced by file-name row + determinate progress bar (`.progress-bar`,
  track `--color-surface-sunken`, fill `--color-brand`, 8px, `--radius-full`), percentage + ETA,
  `.btn-secondary` "בטל" cancel. `aria-live="polite"` announces at 25/50/75/100%.
- **Error:** icon swaps to `alert-circle`, inline error line above the zone, resets to idle with
  the file retained (retry re-submits, no re-pick).

### 4.6 Tables (audit log)
Card rows on mobile, `<table>` on `--bp-md`+. Header `background: var(--color-surface-sunken)`,
`--fs-xs` `--fw-semibold` muted, no uppercase (Hebrew has no case), row height 52px,
`border-bottom: 1px solid var(--color-border)`. Email cell wrapped in `.ltr-token`.
Delivery-mechanism cell is a small neutral tag, not a colored pill — mechanism is informational,
not status. Below `--bp-md`: each row becomes a stacked card (`--color-surface`, `--radius-md`,
`--space-3` padding) — same data, no table chrome.

### 4.7 Toasts
Bottom-center on mobile, `inset-inline-end` corner on desktop (never `right`). `--color-surface`,
`--shadow-md`, `--radius-md`, max-width 360px, auto-dismiss 4s, `aria-live="polite"`. Reserved for
system confirmations (file deleted, settings saved) — copy-confirmation (4.3) stays inline.

### 4.8 Modals / confirm dialogs
`--color-surface`, `--radius-lg`, `--shadow-modal`, max-width 420px, centered, scrim
`rgba(23,20,17,0.4)`. Destructive confirm states the irreversible consequence in body text, never
a generic "are you sure." Button row: `.btn-destructive` at `inset-inline-start`, `.btn-secondary`
"ביטול" at `inset-inline-end` — safe action reads first in RTL order, matching OS convention.
Focus trapped; `Escape` closes; initial focus on cancel, never destructive.

### 4.9 Empty states
Centered column, `--space-7` padding, muted icon (48px, `--color-text-faint`), `--fs-lg`
`--fw-semibold` headline, `--fs-sm` muted supporting line, CTA button `--space-5` below. Used for
first-run file list. Empty audit log gets a quieter variant: no icon, no CTA, just the muted line
("עדיין אף אחד לא ביקש את הקובץ הזה") — it's a sub-section, not a whole-page state.

---

## 5. Per-screen notes

**Sign-in:** centered card, `max-width: 400px`, vertically centered on desktop, full-bleed on
mobile. Wordmark `--fs-2xl` `--fw-bold` `--color-brand`, `--space-6` above the form. No card
border/shadow on mobile; `--shadow-sm` + border on desktop.

**File list:** `--content-max-wide` container. Header: "הקבצים שלי" (`--fs-xl` `--fw-semibold`)
inline-start, "+ קובץ חדש" `.btn-primary` inline-end. Rows: type icon + file name (`--fs-md`
`--fw-medium`) + status pill + delivery-count, end-aligned. Row hover `--color-surface-sunken`,
whole row clickable. Loading: 4 skeleton rows, no spinner.

**Upload:** dedicated screen, not a modal — size-limit line + dropzone are the whole above-the-fold
content, `max-width: var(--content-max)`, centered.

**Per-file page:** `--content-max` (720px), `--space-6` between sections (header, distribution
card, email card, settings, audit table, delete). Header: file name `--fs-xl` `--fw-semibold` +
status pill inline-end, meta line below. The two artifact cards (4.3) stack `--space-4` apart,
always both rendered — the brief's "must feel great" screen, so nothing collapses into an
accordion on mobile; it's a scroll, not a click. Settings: plain vertical form, `.btn-primary`
"שמור" inline-start under the fields. Delete sits `--space-7` below, alone, never adjacent to it.

**Branded embed page (flag ON):** mobile-first, `--bp-sm` target. Full-bleed `--color-bg`, no
chrome beyond the wordmark. **Wordmark:** text-only `"Swenlly"`, `--font-sans` `--fw-bold`
`--fs-lg` `--color-brand`, centered, `1px solid var(--color-border)` rule beneath — its restraint
(no nav, no tagline) *is* the brand signal, no logotype needed. Below: file name (`--fs-md`,
centered), optional sender-identity line, embed frame (`aspect-ratio` 4/3 docs / 16/9 video),
full-width download `.btn-primary`. Expired: embed + download removed, centered `alert-circle` +
"הקישור הזה כבר לא פעיל," wordmark retained.

**Expired page** (if standalone): identical to the embed page's expired variant — same pattern,
not a second one.

---

All values above are final, not placeholders. One open item: the embed frame's `aspect-ratio` per
file type should be checked against real Zoho embed markup; use `4/3`/`16/9` until then.
