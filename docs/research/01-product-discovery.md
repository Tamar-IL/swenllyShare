# Product Discovery — Filter-Proof Email Marketing Platform

**Gate:** DISCOVERY (research, not build). **Author:** Product Manager.
**Date:** 2026-09-07. Solutions kept open; this is the *what & why*.

> **One-line thesis.** The two "novel automations" are not the product. The product is
> **email as a filter-proof delivery rail for the Haredi kosher-internet market** — a place
> where public links die and a custom domain is a luxury. The automations are how you make
> that rail feel like a modern marketing platform.

---

## 1. Problem & who has it

**Hypothesis (investigated → LARGELY CONFIRMED).** The founder's Hebrew repos + "filtered
internet where public links are blocked" + "no custom domain" + "Zoho WorkDrive as the slow
exception" point squarely at the **Israeli Haredi (ultra-Orthodox) market that runs
kosher-filtered internet ("אינטרנט מסונן")**. Every constraint in the brief is a native
property of that environment. I did not find an equally strong alternative reading, so I'm
proceeding on this audience.

**The audience is real and large-and-growing:**
- ~**1,452,350 people, 14.3% of Israel** in 2025; growing **~4.2%/yr** (fastest in the
  developed world); projected **16% by 2030** and **2M by 2033**. Very young: **57% under
  20**. ([IDI 2025](https://en.idi.org.il/haredi/2025/?chapter=63076),
  [Times of Israel](https://www.timesofisrael.com/haredim-are-fastest-growing-population-will-be-16-of-israelis-by-decades-end/))
- Digitally reachable despite the modesty framing: Haredi-sector reporting claims **~88% have
  a personal email**, and describes email as *the most-used and most effective digital medium
  in the sector* — because it survives the filter when the open web does not.
  ([Charedistyle](https://charedistyle.co.il/2022/11/מחקרים-מראים-שיש-לכ-88-מהמגזר-החרדי-מייל/))

**Their environment — why normal tools fail (this is the whole game):**
- Filters (**Netfree, Rimon, Netspark, Jnet, Yeshivanet**) work on a **whitelist**: only
  approved domains/pages resolve, and images/video are often **manually screened** before
  they render. Rimon filters at the ISP level so it "theoretically can't be bypassed."
  ([Vice](https://www.vice.com/en/article/kosher-internet-filters/),
  [Ynet](https://www.ynetnews.com/articles/0,7340,L-3446129,00.html),
  [NetFree forum](https://en.forum.netfree.link/topic/99/what-is-the-difference-between-netfree-and-rimon))
- **Consequence:** a Mailchimp campaign is a wall of dead links and stripped images. A
  "click here to view file / unsubscribe / confirm" link on a random SaaS domain simply does
  not load. Hosted-image tracking pixels don't fire. **The link-centric web that every major
  ESP is built on is broken here.** A custom whitelisted domain fixes it — but that's
  exactly the cost/expertise the target user doesn't have.
- What *does* get through reliably: **email itself** (inbound + outbound), **attachments**,
  and a small set of **already-whitelisted domains** (major providers, some drives). This is
  the seam the whole product lives in. A local player, **"שלח מסר" (Shlach Meser)**, already
  advertises sending **20 MB files with images that display even under strict filtering** —
  proof the seam is real *and already contested*.

**Cagan's four tests, honest scoring:**
- **Valuable? — Strong.** A genuinely painful, unserved job (reach a filtered audience
  without a domain). Email is stated to be the sector's top-performing channel.
- **Usable? — At risk (top design risk).** The magic is inbox-driven, which is elegant but
  invisible — owners must trust that "someone emailed 'add me' → they're now a subscriber"
  actually happened, and requesters must understand a "reply to get the file" flow. Ease and
  legibility, not features, decide adoption.
- **Feasible? — Yes, with unknowns.** Reading an inbox (IMAP/OAuth), parsing intent, sending
  mail/attachments is well-trodden. The hard part is *reliable delivery under filters* and
  *not looking like spam* — an ops problem, not an algorithm problem.
- **Viable? — Plausible, unproven.** Willingness to pay in this sector exists (businesses
  already buy דיוור/mailing systems via portals like פרוג) but price sensitivity is high and
  the incumbent (Shlach Meser) is entrenched. Needs validation.

---

## 2. Competitive landscape — table-stakes vs. commodity

The big platforms (Mailchimp, Brevo, MailerLite, Kit/ConvertKit, Beehiiv, and open-source
**Listmonk**) have converged on the same feature set
([Brevo](https://www.brevo.com/blog/best-email-marketing-services/),
[MailerLite](https://www.mailerlite.com/blog/best-email-marketing-service-platforms)):

| Table-stakes feature | Status | Note for our market |
|---|---|---|
| Contact/list management, tags, segments | Commodity | Must have; nothing special |
| Drag-and-drop campaign editor + templates | Commodity | **Must be image-light / link-light** to survive filters |
| Signup forms + landing pages | Commodity | **Near-useless here** — hosted pages are blocked; *this is where our inbox-subscribe replaces the form* |
| Automations / autoresponders (welcome, drip) | Commodity | Our differentiators are automations, just triggered by *inbound mail* |
| Deliverability (SPF/DKIM/DMARC, warmup) | **Hard, decisive** | The real moat; doubly hard under filters |
| Analytics (opens/clicks) | Commodity, **but broken here** | Pixels/link-tracking often blocked → need a filter-safe metric story |
| A/B testing, personalization | Commodity | Defer |
| Free tier + contact-based pricing | Commodity | Sets price expectations |

**Takeaway:** table-stakes are cheap and largely solved by open-source (**Listmonk** gives
lists, campaigns, and sending for free). A new entrant **cannot win on features** — the
entire wedge is *deliverability + usability inside filtered internet without a domain*.
Everything in the commodity column we should assemble, not invent.

---

## 3. The two differentiators — novel? valuable? who else does this?

**(A) Inbox-driven subscription** — someone emails "add me," system auto-adds + confirms.
- **Novel? — Partly.** The *mechanism* (parse inbound mail → mutate a list) is not new;
  auto-responders and Zapier "email → add row" flows exist. What's novel is **making the
  inbound email the primary subscription UI** *because the normal UI (a hosted signup form)
  is physically blocked* by the filter. Novelty = the context, not the tech.
- **Valuable? — Yes, situationally.** Removes the single hardest step for a domain-less owner
  in a filtered world: capturing a subscriber without a working web form. In the open web
  it'd be a gimmick; here it's the point.
- **Benefit vs. complexity:** high benefit, **moderate-high complexity** — intent parsing,
  spoofing/forwarding ambiguity ("who actually consented?"), and consent proof (see §4).

**(B) Inbox-driven private file delivery** — owner uploads a file; system makes an embeddable
public view + a "request this file" button (pre-filled email); the request email triggers a
private share (drive link or attachment for small files).
- **Novel? — The framing is the interesting part.** Auto-reply-with-attachment tools exist
  (Exclaimer Auto Responder, Automatic Email Manager, Auto Reply Pro
  — [Exclaimer](https://user-manuals.exclaimer.com/auto-responder/latest/How_can_I_send_file_attachments_with_an_automatic_reply.htm)).
  The novelty is **routing around blocked public links by making email the transport**: the
  "request this file" pattern converts a dead download-link into a *live inbound trigger*,
  and delivery is an **attachment or a whitelisted-drive link** rather than a blocked SaaS URL.
- **Valuable? — Yes, and this is the sharper of the two.** "Publish a file that people on
  filtered internet can actually receive, without a domain" is a concrete, repeated pain.
  Shlach Meser's 20 MB pitch confirms demand.
- **Benefit vs. complexity:** high benefit, **high complexity** — the "public view" part
  fights the filter (needs a whitelisted host or image-only rendering), storage/quota, and
  the same consent/anti-abuse questions as (A).

**Reframe for the founder:** both differentiators are one bet — **"email is the universal,
filter-proof transport; we automate both directions of it."** Sell that, not two features.

---

## 4. ⚠️ Consent & compliance risk — FLAG LOUDLY (top legal risk)

Auto-adding someone because they emailed you is the legally sensitive core. Findings:

- **Israel is the binding jurisdiction and it is strict.** Amendment 40 to the Communications
  Law ("חוק הספאם") is an **opt-in** regime (EU-style, not US opt-out). Sending commercial
  mail without **prior express consent** is an offense, and — decisively — courts award up to
  **1,000 NIS per message in statutory ("exemplary") damages with no proof of harm**, and the
  Supreme Court set 1,000 NIS as the *starting point*.
  ([Mondaq](https://www.mondaq.com/security/589568/spam-update-first-amendment-to-israeli-spam-law-goes-into-effect),
  [Hunton](https://www.hunton.com/privacy-and-information-security-law/new-anti-spam-law-takes-effect-in-israel))
  A single bad campaign to a few hundred people is six-figure NIS exposure. This is not
  theoretical.
- **Is auto-subscribe-on-inbound defensible?** **Yes, but only if the inbound email itself is
  the express consent** — i.e., the person literally wrote "add me to the list." That likely
  *is* valid opt-in. The danger is the fuzzy cases: a forwarded email, a spoofed sender, a
  file-*request* misread as a *subscribe*, or a business owner who bulk-imports an old inbox.
  Those are non-consented sends → liability.
- **What the confirmation flow must be:**
  - **Minimum: confirmed opt-in (single).** Auto-add, immediately send a confirmation that
    (a) states they were added, (b) offers **one-tap opt-out** *by replying* (not a blocked
    link), (c) is logged. **Do not send marketing before the confirmation.**
  - **Recommended: double opt-in** ("reply YES to confirm"). Not legally *required* by GDPR/
    CAN-SPAM ([iubenda](https://www.iubenda.com/en/blog/gdpr-double-opt-in-2/)), but under
    Israel's opt-in model + 1,000-NIS exposure it is the **cheapest insurance available** and
    the cleanest **audit trail** proving intent. In filtered internet, confirmation must work
    **by email reply**, since a "click to confirm" link may not load.
  - **Always log** the original inbound message (sender, timestamp, raw text) as consent proof.
- **A relevant escape hatch:** Israeli **non-profits / public-benefit companies may email for
  donations or "campaigning" (non-political idea-distribution) without prior consent** (email
  only; opt-out still honored). Many Haredi senders (yeshivot, chesed orgs, kiruv) *are*
  amutot — so a meaningful slice of the target market has a **lawful default that the generic
  ESPs don't exploit.** Worth a compliance-mode toggle, not an assumption.
- **GDPR/CAN-SPAM** apply if senders reach EU/US diaspora Haredi recipients: CAN-SPAM =
  opt-out + honest headers + physical address + "advertisement" labeling; GDPR = lawful basis
  + records. Our confirmed-opt-in flow satisfies both; the Israeli bar is the highest so
  **build to Israel and the rest follows.**

**Verdict:** the feature is buildable *lawfully* only as **auto-add → immediate confirmation →
marketing-only-after-consent**, with a hard audit log. Shipping "auto-add and blast" would be
negligent. This constraint should be treated as a product requirement, not a checkbox.

---

## 5. Thin-slice MVP — the smallest thing that proves the core bet

**The core bet to prove:** *"An owner with no domain can, from their existing inbox, grow a
list and deliver a file to people on filtered internet — and it actually arrives."* Delivery
under filters is the risk; prove that first.

**MVP scope — IN:**
1. **Connect one inbox** (owner's Gmail/Outlook via OAuth/IMAP) — read + send as them.
2. **Inbox-driven subscribe, done legally:** detect an "add me" email → auto-add → send a
   **reply-to-confirm** message → on confirm, subscriber is active. Full consent log.
3. **One filter-safe broadcast:** compose + send a simple, **image-light/link-light**
   campaign to confirmed subscribers, sent through the owner's own (already-whitelisted)
   mailbox so it inherits that deliverability. Reply-based unsubscribe.
4. **Inbox-driven file delivery, small-file path only:** owner uploads a file → gets a
   copy-pasteable **"request this file" pre-filled mailto** → request email triggers an
   **automatic attachment reply** (≤ ~20 MB, matching the incumbent's bar).
5. **A dead-simple dashboard:** subscribers, consent status, sends, and delivery
   confirmations — legible enough that a non-technical owner *trusts the invisible magic*.

**Explicitly OUT (defer, and say so):**
- The **embeddable public file view** (fights the filter; needs whitelisted hosting) — defer
  until the email path is proven.
- **Large-file / drive-based** private delivery (Zoho WorkDrive-style) — the "slow exception";
  revisit after MVP.
- Custom sending domain, SPF/DKIM/DMARC provisioning, dedicated IP warmup.
- Segmentation, A/B testing, drip automations, landing pages, template gallery.
- Click/open analytics (broken under filters anyway) — replace with **reply/bounce-based**
  delivery signals.
- Multi-inbox, team seats, non-profit "campaigning" compliance mode (flag as fast-follow).

**Why this slice:** it exercises the exact seam (inbound intent → lawful consent → outbound
delivery via the whitelisted mailbox) with the least building, and it lets us measure the one
number that matters — **did it actually land inside filtered internet?**

---

## 6. Business model options

- **Freemium, contact-based (matches category norms):** free up to N subscribers/M sends
  ([Brevo/MailerLite free tiers](https://www.brevo.com/blog/best-email-marketing-services/)),
  paid tiers by list size + send volume. Familiar, low-friction, but our costs are storage +
  deliverability ops, so meter those.
- **Flat monthly per sender (SMB-friendly):** the Haredi business buyer (via portals like
  פרוג) is used to paying a fixed monthly for a דיוור system. Predictable; likely the best
  first monetization.
- **Per-file / storage add-on:** the file-delivery feature is a distinct value unit — charge
  for storage/quota and large-file drive delivery as an upsell.
- **Non-profit / community tier:** discounted plan for amutot (large slice of the market),
  aligned with the legal campaigning exemption — good for adoption and goodwill.
- **Who pays:** small Haredi businesses, community organizations/yeshivot, content creators
  (magidei shiur, newsletter writers) — the sender, not the recipient. B2B2C.
- **Avoid:** ad-supported or recipient-facing monetization (culturally and technically wrong
  for filtered internet).

---

## 7. Top 5 risks

1. **Deliverability under filters is the whole product and it's the least proven.** If sends
   don't reliably land inside Netfree/Rimon without a whitelisted domain, nothing else
   matters. *Mitigate:* MVP sends through the owner's own already-whitelisted mailbox; measure
   real landing rate before building anything else.
2. **Legal exposure from auto-subscribe (1,000 NIS/message, opt-in regime).** One
   misclassified "add me" or bulk-import = statutory damages. *Mitigate:* confirmed/double
   opt-in by reply, hard consent log, no marketing pre-confirmation — as a product invariant.
3. **Entrenched local incumbent (Shlach Meser + existing דיוור systems).** The 20 MB /
   filter-visible-images pitch already exists; we're not first. *Mitigate:* win on the
   *combined* inbound-subscribe + file-delivery + lawful-consent story and superior UX, not on
   any single feature.
4. **Usability of invisible automation (the Cagan "usable?" risk).** If owners don't trust
   that the magic happened, or requesters don't understand "reply to get the file," adoption
   stalls regardless of engineering. *Mitigate:* obsessive legibility — confirmations,
   status, and plain-language flows; test with real Haredi users early.
5. **Inbox access fragility & abuse.** OAuth scope changes, IMAP throttling, a compromised or
   spoofable trigger inbox, and the owner's mailbox reputation being burned by volume. Reading
   a user's inbox is also a **security/PII surface** (→ appsec at build). *Mitigate:* least-
   privilege scopes, rate limits, sender verification on triggers, clear data handling.

---

## 8. Open questions for the founder

1. **Audience confirmation:** is the target specifically the Israeli Haredi filtered-internet
   market? (Everything above assumes yes.) Any diaspora Haredi (US/EU) in scope for v1?
2. **Sending identity:** are we sending *as the owner's own mailbox* (inherits their filter
   whitelist — the MVP assumption) or building our own sending infra + whitelisted domain
   (bigger bet, later)?
3. **Which incumbent are we displacing** — Shlach Meser, פרוג-listed systems, or people
   hand-rolling with Gmail? Who's the beachhead buyer: businesses, orgs, or creators?
4. **File delivery priority:** is the *public embeddable view* essential to v1, or is the
   private email-delivery path enough to prove value first?
5. **Compliance appetite:** OK to make double-opt-in-by-reply the non-negotiable default even
   though it adds one step, given the 1,000-NIS exposure?

---

### Sources
- IDI, *Statistical Report on Ultra-Orthodox Society 2024/2025* — https://en.idi.org.il/haredi/2025/?chapter=63076
- Times of Israel, Haredi growth to 16% — https://www.timesofisrael.com/haredim-are-fastest-growing-population-will-be-16-of-israelis-by-decades-end/
- Vice, *Kosher Internet filters* — https://www.vice.com/en/article/kosher-internet-filters/
- Ynet, *Glatt kosher internet* (Rimon) — https://www.ynetnews.com/articles/0,7340,L-3446129,00.html
- NetFree forum, NetFree vs Rimon — https://en.forum.netfree.link/topic/99/what-is-the-difference-between-netfree-and-rimon
- Charedistyle, 88% of the sector have personal email — https://charedistyle.co.il/2022/11/מחקרים-מראים-שיש-לכ-88-מהמגזר-החרדי-מייל/
- Mondaq, *First Amendment to Israeli Spam Law* — https://www.mondaq.com/security/589568/spam-update-first-amendment-to-israeli-spam-law-goes-into-effect
- Hunton, *New Anti-Spam Law Takes Effect in Israel* — https://www.hunton.com/privacy-and-information-security-law/new-anti-spam-law-takes-effect-in-israel
- iubenda, *Does GDPR require double opt-in?* — https://www.iubenda.com/en/blog/gdpr-double-opt-in-2/
- Exclaimer, *Auto-reply with attachments* — https://user-manuals.exclaimer.com/auto-responder/latest/How_can_I_send_file_attachments_with_an_automatic_reply.htm
- Brevo, *Best email marketing platforms 2026* — https://www.brevo.com/blog/best-email-marketing-services/
- MailerLite, *Best email marketing platforms* — https://www.mailerlite.com/blog/best-email-marketing-service-platforms
