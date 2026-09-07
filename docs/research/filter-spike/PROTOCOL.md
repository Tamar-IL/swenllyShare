# Filter Spike — does email actually beat the kosher filter?

**Why:** the entire product rests on one assumption — *a message and its files reach a
filtered (NetFree / Rimon / Netspark) user and are usable.* This 15-minute test proves it
before we build anything. It needs no code and no domain.

**You need:** (a) one **normal Gmail** (not filtered) to send from — call it the *SENDER*;
(b) one email account **on the filtered device** to receive — call it the *FILTERED INBOX*.
(A friend/family account behind the filter works too.)

---

## Part A — Outbound: what the owner sends, does it land?

From the **SENDER** Gmail, send these three separate emails to the **FILTERED INBOX**, then
check them **on the filtered device**.

### Email 1 — "the broadcast" (tests text, images, links, reply)
Subject: `בדיקה 1 — ניוזלטר`
Paste this into the Gmail body (it mixes the things filters usually break):

```
שלום! זו בדיקה.
1) האם אתה קורא את הטקסט הזה בבירור?
2) למטה יש תמונה — האם היא מוצגת?
3) יש קישור — האם הוא נפתח או חסום?
4) בבקשה השב למייל הזה עם המילה "כן".
```
- Insert **one image** using Gmail's *Insert photo* (any picture).
- Add **one link** in the text — e.g. `https://example.com` and also a public Google-Drive
  or Zoho link if you have one handy.

### Email 2 — "small file" (tests attachment ≤ our attach limit)
Subject: `בדיקה 2 — קובץ קטן`
**Attach any small PDF you already have** (a flyer/form, ~1–3 MB). Body: "האם הקובץ מצורף ונפתח?"

### Email 3 — "big file" (tests the 20 MB attachment path)
Subject: `בדיקה 3 — קובץ גדול`
**Attach any file around ~20 MB** you already have (a short video, a big PDF/scan). Body:
"האם הקובץ הגדול ירד? כמה זמן לקח?"

---

## Part B — Inbound: can a filtered user send TO the owner?
From the **FILTERED INBOX** (on the filtered device), send one email to the **SENDER** Gmail.
Subject: `בקשת הצטרפות` — body: "צרף אותי לרשימה". (This mimics a subscribe request.)

---

## Results — fill this in and send back to me

Copy this, replace the `?`, and paste it back to me (or commit it here).

```
FILTER USED (NetFree / Rimon / Netspark / other): ?

--- Email 1 (broadcast) ---
Arrived in inbox?                    yes / no
Text readable?                       yes / no
Inserted image shown or stripped?    shown / stripped
Link — opened or blocked?            opened / blocked   (which link: ?)
Could you REPLY "כן"?                yes / no

--- Email 2 (small file) ---
Arrived?                             yes / no
Attachment downloaded & opened?      yes / no
Roughly how fast?                    instant / few sec / slow

--- Email 3 (~20 MB file) ---
Arrived?                             yes / no
Downloaded & opened?                 yes / no
How long did the download take?      ? seconds/minutes

--- Part B (inbound) ---
Did your email from the filtered device reach the SENDER Gmail?   yes / no

Anything surprising / anything blocked with a filter message?     ?
```

---

## How to read the result

- **Email 1 arrives + readable + reply works** → the core channel (broadcast + double-opt-in
  confirm) is viable. Stripped images just mean "design image-light" (already the plan).
- **Small + 20 MB attachments download** → the whole file-delivery MVP works with **zero
  infrastructure and no domain**. This is the result we're hoping for.
- **Links blocked** → expected, and it *confirms the wedge*: that's exactly why link-based
  competitors fail and attachments win.
- **20 MB fails or is painfully slow** → we cap the MVP at whatever size *does* work, and the
  platform-owned whitelisted-domain link becomes a real (post-MVP) need — a domain decision
  we'd revisit then, not now.
- **Part B fails** → filtered users can't email out, which would reshape the inbound features;
  we'd rethink. (Unlikely — ~88% of the sector uses email.)
