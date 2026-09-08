# UX Brief — Swenlly Share (System 2)

**Owner:** Product Designer · **Date:** 2026-09-07
**Inputs:** `docs/01-prd-file-sharing.md` (§2, §4, §5, §8), `docs/research/04-refined-problem-model.md`, `docs/05-kickoff-brief.md`.
**For:** frontend-engineer (build), ui-visual-designer (visual pass), qa-engineer (state coverage).

This brief specifies the sender app and both recipient paths precisely enough to build without
re-deriving the flow. It does not prescribe pixels, type, or color — that's the visual pass.

---

## 0. Assumptions (stated because the PRD leaves them open)

- **Auth: magic-link email sign-in, no password.** No per-sender OAuth (locked decision) and no
  payments/plans to gate in MVP, so a full account system is overkill. Sender enters their email
  → receives a one-time sign-in link → session cookie, 30-day sliding expiry. This is the
  simplest thing that gives us tenant isolation (AC-A3) without building password reset, SSO, or
  OAuth consent screens. **Assumption to confirm with founder:** one sender = one email = one
  tenant; no team/multi-seat accounts in MVP.
- **No analytics, no folders** (PRD non-goals) — the file list is a flat, reverse-chronological
  list. No search is specified for MVP; add a simple filter-as-you-type only if the list is
  expected to exceed ~30 files per sender (ask PM if this is a real ceiling; default to building
  it since it's cheap and the list has no other organization).
- **RTL-first, Hebrew-first.** Audience is Israeli Haredi; sender-facing UI ships RTL Hebrew with
  English copy acceptable as fallback strings in MVP (i.e., don't block launch on translating
  every microcopy string, but the *layout* must be RTL-correct from day one — retrofitting RTL
  is expensive, shipping English strings inside an RTL frame is not).
- **Branded embed page is behind a flag, default OFF** (PRD §5). This brief designs both states;
  the OFF state requires zero recipient-facing design (it's a raw Zoho URL).

---

## 1. Sender app

### 1.1 Sign-in

```
┌─────────────────────────────┐
│        Swenlly Share         │        (logo/wordmark, centered)
│                               │
│  [ הכנס את כתובת המייל שלך ]  │  ← email input, RTL, dir=rtl
│                               │
│         [ שלח קישור כניסה ]   │  ← primary button
│                               │
│  אין צורך בסיסמה — נשלח לך    │  (helper microcopy)
│  קישור התחברות למייל          │
└─────────────────────────────┘
```
- Submit → **"בדוק את המייל שלך"** confirmation screen (don't reveal whether the email exists —
  same message either way, standard practice against account enumeration).
- Magic link opens → session created → redirect straight to the file list. No separate
  "welcome"/onboarding screen for MVP; the empty file list *is* the onboarding (see 1.2).
- **Error state:** link expired/already used → plain message + a button to request a new one.
  Never a dead end with no recovery action.

### 1.2 File list ("my files")

Flat table/card list, newest upload first. Row shows: display file name, upload date, expiry
status chip (Active / Expiring soon / Expired), a mini delivery count ("נשלח ל-3" / "לא נשלח
עדיין"). Clicking a row opens the per-file page (1.4).

```
┌──────────────────────────────────────────────┐
│  הקבצים שלי                    [+ קובץ חדש]   │
├──────────────────────────────────────────────┤
│  📄 חוברת_חתונה.pdf     פעיל · נשלח ל-12      │
│  🎬 סרטון_ברית.mp4      פג תוקף בעוד 2 ימים   │
│  📄 מסמך.pdf            פג תוקף · אין גישה     │
└──────────────────────────────────────────────┘
```

**States:**
- **Loading:** skeleton rows (3–4 gray bars), not a spinner-only screen — avoids layout jump
  when data lands.
- **Empty (first-run):** replaces the list with a single centered prompt: *"עדיין לא העלית קובץ"*
  + the same "+ קובץ חדש" action, large. This is the only onboarding the product needs — it
  puts the one action the user must take front and center instead of a separate tutorial.
- **Error (list failed to load):** inline message + "נסה שוב" retry button; never blank-white
  with no explanation.

### 1.3 Upload flow

Single-step, modal or dedicated screen — drag-and-drop zone **and** a "browse" picker button in
the same control (don't force drag-drop only; Haredi users skew toward being less comfortable
with drag gestures on desktop, and this population is disproportionately mobile — a file picker
must always be present).

```
┌──────────────────────────────────────────────┐
│         גרור קובץ לכאן, או                     │
│           [ בחר קובץ מהמחשב ]                  │
│                                                │
│   קבצים גדולים עד 5GB נתמכים                   │
└──────────────────────────────────────────────┘
```
- **Size limit:** state a concrete ceiling in the UI *before* upload starts (e.g. up to 5 GB —
  confirm the real ceiling against the Zoho WorkDrive plan limit with the architect/backend
  engineer; the number here is a placeholder, not a spec). Rejecting a too-large file must happen
  client-side immediately on selection, not after a failed upload.
- **Progress:** determinate progress bar with percentage and, for large files, an estimated
  remaining time once one is computable. A cancel action must be available mid-upload.
- **Failure (network drop, server error, virus/type rejection):** the upload zone returns to its
  initial state with an inline error line above it (e.g. *"ההעלאה נכשלה — נסה שוב"*) and the
  selected file is retained so retry doesn't require re-picking it.
- **Success:** immediately routes to that file's per-file page (1.4) with settings in their
  default state — the sender should never have to hunt for what they just uploaded.

### 1.4 Per-file page (delivers AC-U1's three artifacts)

This is the product's core screen. Layout, top to bottom:

```
┌──────────────────────────────────────────────────────────┐
│ ← חזרה לרשימה                                              │
│                                                            │
│  חוברת_חתונה.pdf                              [Active ●]  │
│  הועלה ב-3 בספטמבר · פג תוקף בעוד 12 יום                   │
│                                                            │
│ ── קישור להפצה ─────────────────────────────────────────  │
│  https://zoho.workdrive.link/abc123           [העתק 📋]   │
│  למי לשלוח את זה: אנשים עם אינטרנט מסונן (נטפרי/רימון).    │
│  הקישור הזה עובר את הסינון ונפתח ישירות.                   │
│                                                            │
│ ── קישור בקשה במייל ────────────────────────────────────  │
│  mailto:file-abc123@share.swenlly.com          [העתק 📋]  │
│  למי לשלוח את זה: אנשים עם אימייל בלבד (ללא גישה כללית     │
│  לאינטרנט). לחיצה תפתח מייל מוכן מראש — הם רק שולחים אותו, │
│  והקובץ יגיע אליהם תוך דקות.                                │
│                                                            │
│ ── הגדרות ──────────────────────────────────────────────  │
│  שם הקובץ המוצג:  [ חוברת חתונה             ]              │
│  הודעה אישית:     [ טקסט חופשי, יופיע במייל התשובה ]       │
│  תוקף:            ( ) ללא תוקף  (•) 30 יום  ( ) מותאם אישית │
│                                              [ שמור ]       │
│                                                            │
│ ── מי קיבל את הקובץ ────────────────────────────────────  │
│  israel@gmail.com     נשלח כקובץ מצורף    3 בספטמבר, 14:02 │
│  dvora@gmail.com      שיתוף Drive פרטי    3 בספטמבר, 09:15 │
│  (ריק: "עדיין אף אחד לא ביקש את הקובץ הזה")                │
│                                                            │
│                                          [ מחק קובץ 🗑 ]    │
└──────────────────────────────────────────────────────────┘
```

**Two links, always both visible, never a toggle between them** — the sender doesn't know in
advance which recipients are filtered-internet vs. email-only, so both artifacts ship on every
file per AC-U1, each with a one-line plain-language explainer of *who it's for and what happens
when they use it* (senders are not technical; "distribution link" and "mailto" are implementation
terms, not what appears in the UI).

- **Copy-to-clipboard**: button next to each link/address, standard clipboard write, brief
  inline confirmation ("הועתק" toast/label swap for ~2s, not a modal).
- **Expiry states**, shown as a status chip at the top of the page and reflected in the file list:
  - **Active** (green/neutral) — link and any private shares work normally.
  - **Expiring soon** (amber) — inside the last 3 days of the window; same functionality, just a
    heads-up so the sender can extend before it lapses.
  - **Expired** (gray/red) — link and email-request both stop granting access (AC-U4). The
    distribution link section on this screen visually shows as inactive; the mailto is disabled
    with a note: *"תוקף הקובץ פג — בקשות חדשות לא יתקבלו"*. Underlying data isn't deleted; expiry
    is enforced at the access layer.
- **Audit view ("who has received")**: satisfies AC-A2 as a plain, non-technical table —
  recipient address, delivery mechanism (attachment vs. Drive share), timestamp. No raw DMARC
  jargon in this view; that detail belongs in a "details" expand if support/ops need it, not in
  the sender-facing default row.
- **Delete/revoke:** a single destructive action, confirmed with a plain-language dialog
  ("הקובץ יימחק ואף אחד לא יוכל לגשת אליו יותר — לא ניתן לבטל"). Deleting removes access
  immediately (equivalent to instant expiry) and removes the file from the list; underlying
  storage cleanup is a backend concern, not a UI state.

---

## 2. Recipient — filtered-internet path (distribution link)

### Flag OFF (MVP default, AC-U2)
The link *is* the raw Zoho WorkDrive public URL. There is no Swenlly surface here — nothing to
design. The recipient's experience is entirely Zoho's own page.

### Flag ON (AC-U3, once swenlly.com is whitelisted)
A `swenlly.com` page wraps the Zoho file; the raw Zoho URL must never appear as the visible
destination (not in the address bar's user-facing label, not in any visible link/share text on
the page — the underlying fetch/embed source is a technical detail, the *displayed* origin and
any copyable link on this page must read swenlly.com).

```
┌──────────────────────────────────────────────┐
│              Swenlly                          │   (wordmark only — no nav, no upsell)
│                                                │
│         חוברת_חתונה.pdf                        │   (display name from sender settings)
│      נשלח אליך על ידי [שם השולח/מותג]           │   (optional, if sender identity is known)
│                                                │
│   ┌────────────────────────────────────┐      │
│   │                                    │      │
│   │      [ embedded file / video ]      │      │
│   │                                    │      │
│   └────────────────────────────────────┘      │
│                                                │
│              [ הורד קובץ ⬇ ]                    │
└──────────────────────────────────────────────┘
```
- **Embedded content:** file (PDF/image) rendered inline where the format supports it; video
  gets a native player, not a link-out. Download is a separate, explicit primary action below
  the embed — never rely on the embed alone for the recipient's goal.
- **Expired state:** the page still resolves (the URL itself doesn't 404), but replaces the embed
  and download button with a plain notice: *"הקישור הזה כבר לא פעיל"* — no Zoho error message,
  no stack trace, no dead embed frame.
- **No branding chrome beyond the wordmark** — no nav bar, no "sign up," no marketing. The
  recipient didn't choose to visit Swenlly; the page's only job is deliver the file trustworthily
  and get out of the way.

---

## 3. Recipient — email-only path

### The mailto (pre-filled request email)

```
To:      file-<token>@share.swenlly.com
Subject: בקשה לקבל קובץ: <display file name>
Body:
  שלום,
  אני מבקש/ת לקבל את הקובץ "<display file name>".
  אנא השב/י למייל זה עם הקובץ.

  (Hebrew primary; a one-line English fallback is acceptable in MVP:
   "Requesting the file <display file name>. Please reply with the file.")
```
The subject/body are pre-filled but **editable** by the recipient (it's a normal mailto — the
system cannot lock the body). This is fine: delivery does not depend on parsing the body
(AC-R2 — the file is resolved from the `+file-<token>` address only, never body/subject text),
so an edited or garbled body has no effect on what gets delivered.

### The reply email the requester receives

**Attachment case (≤ ~20 MB):**
```
Subject: הקובץ שלך: <display file name>
Body:    <sender's custom message text, verbatim>
Attachment: <display file name>
```

**Drive-share case (larger files, AC-R5):**
```
Subject: הקובץ שלך: <display file name>
Body:    <sender's custom message text, verbatim>

          לפתיחת הקובץ, לחץ/י כאן:
          [ Google Drive share link ]

          (אם אין לך חשבון Google, תוכל/י לאמת את עצמך
           באמצעות קוד חד-פעמי שיישלח למייל שלך.)
```
Both cases lead with the sender's own words (custom message), not system boilerplate — the
sender's voice is the trust signal to a recipient who doesn't know what "Swenlly" is.

### DMARC-fail / rejection (AC-R1)

**From the requester's point of view: nothing happens.** No bounce, no "request denied" email —
silence is the correct behavior for a spoofed/failed request, since replying at all would
confirm to an attacker that the address is live and would leak file existence to someone who
isn't the real owner. This is a deliberate asymmetry versus the happy path and must be called
out to the requester's real, legitimate mail failing quietly too: if a *genuine* sender's request
fails DMARC (e.g. their own domain is misconfigured), they get silence indistinguishable from an
attack. **This is a real support cost, not a gap to silently accept** — mitigate with a visible
sender-facing note on the per-file page settings ("בקשות מגיעות רק מכתובות מאומתות (DMARC) —
Gmail וכתובות רגילות עובדות; דומיינים מותאמים אישית עשויים להיכשל") so senders can pre-empt
support tickets, and flag to the founder/PM whether a low-volume manual "request didn't arrive"
support path is needed for MVP (currently unspecified).

---

## 4. The one thing that must feel great

**The per-file page (1.4), specifically the moment right after upload.** This product's entire
value proposition collapses into one page: upload once, get both artifacts instantly, understand
in plain language what each one is for. If a sender has to think, guess, or scroll to find "the
link to send" or "the thing for the email-only cousin," the product has failed at its one job.
Concretely: both links generated and visible with zero additional clicks the moment upload
completes; explainer copy answers "who is this for" without the sender needing outside
knowledge of filters/NetFree/Drive; copy-to-clipboard works in one click with immediate visual
confirmation.

**Trust cues — the sender must trust the "invisible" email automation.** The sender never sees
the inbound request happen; the whole email-only path runs unattended. The **audit log
("who has received this file")** is the load-bearing trust mechanism for this — it must update
promptly (near-real-time, not "check back tomorrow") after a delivery so a sender who just told
someone "go request it by email" can refresh and see it worked. Secondary trust cues: the expiry
chip is always visible and unambiguous (a sender must never wonder "is this still live"), and
the delete/revoke confirmation explicitly states the irreversible effect rather than a generic
"are you sure."

---

## 5. Voice/tone, RTL/i18n, accessibility

- **Voice:** plain, warm, non-technical Hebrew. No jargon ("token," "webhook," "DMARC," "OAuth")
  ever surfaces in sender- or recipient-facing copy — those terms exist only in this brief and in
  code. Sentences are short and instructional ("שלח את הקישור הזה למי שרוצה לפתוח את הקובץ"),
  matching a population that is not assumed to be technically fluent.
- **RTL:** all sender-app screens are RTL-native (`dir="rtl"`, mirrored layout — back-navigation
  arrows point right, form fields flow right-to-left). Any embedded English string (a raw URL, a
  file extension) stays LTR-embedded inline per standard bidi handling — don't force URLs into
  RTL rendering, which garbles them. The recipient-facing branded page (§2) is equally RTL.
- **i18n scope for MVP:** Hebrew is the shipping language; English fallback strings are
  acceptable placeholders where Hebrew copy isn't finalized, but no screen ships mixed
  Hebrew/English as a permanent state — treat English strings as a tracked to-do, not a shrug.
- **Accessibility basics:** every icon-only control (copy, delete, drag-drop) has a text label or
  `aria-label`; color is never the only signal for status (the expiry chip pairs color with text
  — "פעיל"/"פג תוקף," not just green/red); focus order follows the RTL visual order; upload
  progress and toasts are announced to screen readers (`aria-live="polite"`); minimum tap target
  44×44px given the mobile-skewed audience.

---

## Open questions (for PM/founder, not guessed here)

1. **Concrete upload size ceiling** — this brief placeholders "5 GB"; needs a real number from
   the Zoho WorkDrive plan + backend chunked-upload spike (kickoff brief spike #1).
2. **Default expiry window** — PRD §10.5 leaves this open; this brief assumes a 30-day default
   with "no expiry" and "custom" options, pending founder confirmation.
3. **Support path for legitimate DMARC failures** (§3) — currently no recovery path exists for a
   genuine sender whose own domain fails DMARC; needs a PM/founder decision on whether MVP needs
   one.
4. **File list search/filter threshold** — built by default per §0 unless PM says the per-sender
   file count will stay low enough to skip it.
5. **Sender identity on the branded page** (§2, flag ON) — shown as "(optional)"; needs
   confirmation on whether senders get a display name/brand field at all in MVP, since there is
   no per-sender branding/profile feature specified elsewhere in the PRD.
