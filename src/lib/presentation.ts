import type { FileRow } from '../db/repositories/files.js';
import type { DeliveryMechanism, DeliveryOutcome } from '../db/repositories/deliveries.js';

/**
 * Frontend-engineer addition (Lane C): pure view-formatting helpers shared by the HTML
 * route handlers (`files.ts`, `public-share.ts`) and their Eta templates' data contracts.
 * Nothing here touches the database or a port — it only translates already-loaded rows
 * into the Hebrew labels/CSS hooks the visual spec defines (`docs/design/visual-spec.md`
 * §4.4 status pills, §1.3 no-jargon copy). Kept out of `domain/*` because it is
 * presentation, not business logic — no acceptance criterion depends on it.
 */

export type DisplayStatus = 'publishing' | 'failed' | 'active' | 'expiring' | 'expired' | 'deleted';

const EXPIRING_SOON_MS = 3 * 24 * 60 * 60 * 1000;

/** Combines the raw `files.status` lifecycle column with the expiry window into the one
 * status the sender actually needs to see (UX brief §1.4: "a sender must never wonder is
 * this still live"). `ready` fans out into active/expiring/expired depending on
 * `expires_at` vs. `now`; every other `FileStatus` maps straight across. */
export function computeDisplayStatus(
  file: Pick<FileRow, 'status' | 'expires_at'>,
  now: Date,
): DisplayStatus {
  if (file.status === 'staged' || file.status === 'publishing') return 'publishing';
  if (file.status === 'failed') return 'failed';
  if (file.status === 'deleted') return 'deleted';
  if (file.status === 'expired') return 'expired';
  // status === 'ready'
  if (file.expires_at && file.expires_at.getTime() <= now.getTime()) return 'expired';
  if (file.expires_at && file.expires_at.getTime() - now.getTime() <= EXPIRING_SOON_MS) {
    return 'expiring';
  }
  return 'active';
}

/** Label + pill modifier class for each `DisplayStatus` (visual-spec §4.4). `publishing`
 * and `failed` are not in the spec's pill list (it only names active/expiring/expired/
 * quarantined/delivered) — tasteful defaults added here, reusing the spec's existing
 * tokens rather than inventing new colors: `publishing` gets a neutral/muted treatment
 * (nothing has gone wrong, there is just nothing to show yet), `failed` reuses the
 * danger/quarantine palette (a publish failure is the one sender-facing state that
 * actually needs the "something is wrong" red, unlike routine expiry). */
export const STATUS_META: Record<DisplayStatus, { label: string; pillClass: string }> = {
  publishing: { label: 'מתפרסם', pillClass: 'pill-publishing' },
  failed: { label: 'העלאה נכשלה', pillClass: 'pill-failed' },
  active: { label: 'פעיל', pillClass: 'pill-active' },
  expiring: { label: 'פג תוקף בקרוב', pillClass: 'pill-expiring' },
  expired: { label: 'פג תוקף', pillClass: 'pill-expired' },
  deleted: { label: 'נמחק', pillClass: 'pill-expired' },
};

/** Label + pill modifier class for a `deliveries.outcome` row in the audit table
 * (UX brief §1.4 "who has received this file", AC-A2). `not_allowlisted`/`rate_limited`
 * reuse the neutral "expired" gray (a routine policy block, not an attack); `quarantined`
 * is the one outcome that gets the red "security" treatment (visual-spec §4.4: red is
 * reserved for security states). */
export const OUTCOME_META: Record<DeliveryOutcome, { label: string; pillClass: string }> = {
  queued: { label: 'בתהליך', pillClass: 'pill-publishing' },
  sent: { label: 'נשלח', pillClass: 'pill-delivered' },
  // Fix pass 5, F-A: the honest "we don't actually know" outcome — never silently shown
  // as delivered. Reuses the danger/quarantine treatment (visual-spec §4.4): this is the
  // one non-attack outcome that still needs the sender's attention, not a routine gray.
  unconfirmed: { label: 'לא מאומת', pillClass: 'pill-quarantined' },
  failed: { label: 'נכשל', pillClass: 'pill-failed' },
  quarantined: { label: 'נחסם', pillClass: 'pill-quarantined' },
  rate_limited: { label: 'הגבלת קצב', pillClass: 'pill-expired' },
  expired: { label: 'פג תוקף', pillClass: 'pill-expired' },
  not_allowlisted: { label: 'לא ברשימת ההיתר', pillClass: 'pill-expired' },
};

const MECHANISM_LABELS: Record<DeliveryMechanism, string> = {
  attachment: 'קובץ מצורף',
  drive_share: 'שיתוף Drive פרטי',
};

export function mechanismLabel(mechanism: DeliveryMechanism | null): string {
  return mechanism ? MECHANISM_LABELS[mechanism] : '—';
}

const HEBREW_MONTHS = [
  'בינואר',
  'בפברואר',
  'במרץ',
  'באפריל',
  'במאי',
  'ביוני',
  'ביולי',
  'באוגוסט',
  'בספטמבר',
  'באוקטובר',
  'בנובמבר',
  'בדצמבר',
];

export function formatHebrewDate(date: Date): string {
  const month = HEBREW_MONTHS[date.getMonth()] ?? '';
  return `${date.getDate()} ${month} ${date.getFullYear()}`;
}

export function formatHebrewDateTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${formatHebrewDate(date)}, ${hh}:${mm}`;
}

/** Whole days remaining, rounded up — "expires in 2 days" should still say 2 with 36h left. */
export function daysUntil(date: Date, now: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

/** The per-file page's meta line (UX brief §1.4: "הועלה ב-3 בספטמבר · פג תוקף בעוד 12 יום"). */
export function expiryMetaLabel(status: DisplayStatus, expiresAt: Date | null, now: Date): string {
  if (status === 'publishing') return 'מתפרסם כעת';
  if (status === 'failed') return 'העלאה נכשלה';
  if (!expiresAt) return 'ללא תוקף';
  if (status === 'expired') return 'פג תוקף';
  return `פג תוקף בעוד ${daysUntil(expiresAt, now)} ימים`;
}

/** The file list row's secondary line — delivery count, no jargon (UX brief §1.2 mock:
 * "נשלח ל-12" / "לא נשלח עדיין"). */
export function deliveryCountLabel(sentCount: number): string {
  return sentCount > 0 ? `נשלח ל-${sentCount}` : 'לא נשלח עדיין';
}

export function isVideoMime(mime: string): boolean {
  return mime.startsWith('video/');
}

/** Human-readable byte ceiling for the upload screen's size-limit line (UX brief §1.3:
 * "state a concrete ceiling in the UI before upload starts"). Bug 5 (QA report): needs a
 * KB tier — without one, any cap under 1MB rounded to "0MB", disagreeing with the
 * client-side `humanSize()` in `island.js` which already formats the same value
 * correctly. Mirrors that function's tiers/rounding for consistency between the two. */
export function formatByteCeiling(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) {
    const rounded = Math.round(gb * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}GB`;
  }
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) {
    return `${Math.round(mb)}MB`;
  }
  const kb = bytes / 1024;
  return `${Math.round(kb)}KB`;
}
