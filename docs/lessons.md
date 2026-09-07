# Lessons Ledger — Swenlly System 2 (File Sharing)

The self-improving loop (CLAUDE.md §7): a failure caught by a reviewer becomes a one-line
regression lesson here, and future work is checked against it. Seeded with the load-bearing
findings from Discovery so the build never re-learns them the hard way.

| Date | Caught by | Symptom | Root cause | Rule that prevents it |
|---|---|---|---|---|
| 2026-09-07 | AI Red Team | Auto-sharing a file because an email "asked" trusts the `From:` — spoofable | Email `From` has no cryptographic guarantee without DMARC alignment | Verify DMARC on every inbound trigger; share only to the verified sender's own address; rate-limit per sender/file; audit log. |
| 2026-09-07 | PM / Trust & Safety | Auto-subscribing on an inbound email risks ₪1,000/msg (Israeli spam law) and poisons deliverability | Adding to the sendable list before consent is confirmed | Double opt-in by default: inbound "הצטרפות" → reply-to-confirm ("כן") → then add + consent log. Never blast before confirm. |
| 2026-09-07 | AppSec | Full-inbox OAuth would trigger Google CASA ($$/yr) and make a breach expose the owner's whole inbox | Reading the customer's personal mailbox for "listening" | Listen via per-customer addresses on our own domain (Mailgun), not personal-inbox OAuth. If customer files ever need OAuth, scope Google to `drive.file` (CASA-free). |
| 2026-09-07 | Architect | White-label "Swenlly page" would be blocked for filtered users | Filters gate at the domain before the page loads; an unwhitelisted parent page never renders (iframe never runs) | Raw Zoho public link is the default filter-passing path; the branded embed page ships behind a flag, OFF until swenlly.com (and the zohoexternal embed domain) are whitelisted. |
| 2026-09-07 | Backend spike | Google's ~350/file share limit is not a fixed number | It's an undocumented, velocity-based anti-abuse trigger | Don't hard-code 350: detect the quota error and duplicate the file + swap the ID reactively, with margin. |
