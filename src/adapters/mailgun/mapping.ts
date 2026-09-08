import type { InboundMessage } from '../../ports/inbound-mail.js';
import { parseSingleMailbox } from '../../lib/email-address.js';

/**
 * Maps Mailgun's raw inbound-route form payload into our normalized `InboundMessage` DTO.
 *
 * `recipient`, `from`/`From`, `subject`, `body-plain`, `Message-Id`, `timestamp` and
 * `token` are Mailgun's own stable, documented webhook field names (Routes / Store-and-
 * notify), not a guess.
 *
 * **F-1 (critical, `docs/security/red-team-report.md`), hardened further in fix pass 5
 * (F-B, `docs/reviews/critic-report.md`).** DMARC/SPF/DKIM used to be read by probing five
 * GUESSED key names (`dmarc`, `Dmarc`, `X-Mailgun-Dmarc-Result`, ...) in the same flat
 * payload namespace that ALSO carries the inbound message's own MIME headers — Mailgun's
 * inbound routes flatten every MIME header into the POST body alongside its synthetic
 * fields, so a requester who adds `X-Mailgun-Dmarc-Result: pass` to their own outgoing
 * message could assert their own authentication result. The F-1 fix narrowed this to two
 * sources — but F-B's re-check found the anti-forgery guard both sources rely on
 * (`knownHeaderNames`, derived entirely from `message-headers`) is INOPERATIVE whenever
 * `message-headers` is absent from the payload (a contemplated, documented condition, not
 * exotic), and that the weaker of the two sources was also the LESS validated one. Current
 * design, read top to bottom as strict priority:
 *
 *   0. **Fail closed when `message-headers` is absent** (missing, unparseable, or empty).
 *      Both sources below depend entirely on it to tell a genuinely Mailgun-synthesized
 *      field apart from a flattened copy of the sender's own MIME header — with no
 *      `message-headers`, that guard cannot run at all, so NEITHER source is trusted and
 *      every auth field reads `unknown`/`null`. Consistent with `docs/lessons.md`'s rule:
 *      "a guard whose input is optional must fail closed."
 *   (a) The classic Mailgun-documented synthetic top-level fields (`dmarc`, `spf`,
 *       `dkim`, `dmarc-domain`) — kept ONLY in their exact lowercase, single/hyphenated-
 *       word form, Mailgun's own naming convention for its synthetic fields (`body-plain`,
 *       `message-headers`, `attachment-count`, ...). Tried FIRST (fix pass 5: the priority
 *       used to be reversed) because these are Mailgun's own computed metadata about the
 *       envelope, not a copy of anything from the message itself — genuinely
 *       un-spoofable, PROVIDED `message-headers` is present so the dedup guard below is
 *       operative: any field here is discarded if the same key ALSO names a
 *       `message-headers` entry (a duplicate there means the flattened top-level copy
 *       could just as easily be the attacker's own same-named MIME header — indistinguishable,
 *       so it is never trusted).
 *   (b) `Authentication-Results` — the actual RFC 8601 carrier a receiving MTA stamps —
 *       parsed from the `message-headers` JSON array Mailgun documents as carrying every
 *       MIME header in receipt order. Takes the FIRST (topmost) entry whose `authserv-id`
 *       names our receiving host (`MAILGUN_AUTHSERV_ID`, fix pass 5: now REQUIRED
 *       configuration, never defaulted to our own public `INBOUND_DOMAIN` — a value
 *       printed in every mailto link this product hands out, and therefore guessable),
 *       because a receiving MTA PREPENDS its own trace headers, so the topmost matching
 *       one is the most recently added. Tried only when (a) yields nothing.
 *
 *       Fix pass 5 DELETED the old "degraded fallback" — a bare top-level
 *       `payload['Authentication-Results']` field, read whenever `message-headers` lacked
 *       one — entirely. It performed no `authserv-id` check at all (the weaker path was
 *       the LESS validated one) and step 0 above already makes it unreachable in the one
 *       case it existed for (`message-headers` absent); keeping it around as dead,
 *       unvalidated code was itself a risk.
 *
 * `INBOUND_AUTH_SOURCE` (config) selects which of (a)/(b) run; default `both` tries (a)
 * first and falls back to (b) only when (a) yields nothing.
 *
 * **This is still `@unverified-live`** (architecture.md §12, `docs/runbooks/live-spikes.md`
 * spike #3): nobody on this project has inspected a real Mailgun inbound payload, so the
 * exact field name(s) above are the best-documented guess, not a confirmed fact. Until a
 * live payload is captured, `INBOUND_REQUESTS_ENABLED=false` (fix pass 5: now the schema
 * DEFAULT, not just an available switch) holds the inbound path closed with no code deploy
 * needed to hold or resume it (see `RequestPipeline`).
 */
const DMARC_MAILGUN_FIELD = 'dmarc';
const SPF_MAILGUN_FIELD = 'spf';
const DKIM_MAILGUN_FIELD = 'dkim';
const DMARC_DOMAIN_MAILGUN_FIELD = 'dmarc-domain';
const AUTHENTICATION_RESULTS_HEADER = 'authentication-results';

export type InboundAuthSource = 'authentication-results' | 'mailgun-fields' | 'both';

export interface MailgunMappingConfig {
  /** The receiving host name Mailgun's `Authentication-Results` header should name
   * (RFC 8601 `authserv-id`). Matched by exact equality or as a DNS suffix (`authservId
   * === configured || authservId.endsWith('.' + configured)`) so `mxa.<domain>`-shaped
   * real-world values still match a `<domain>`-shaped config default. */
  authservId: string;
  authSource: InboundAuthSource;
}

interface ParsedAuthResult {
  authservId: string;
  dmarc: 'pass' | 'fail' | 'none' | null;
  spf: string | null;
  dkim: string | null;
  dmarcDomain: string | null;
}

interface AuthExtraction {
  dmarc: InboundMessage['dmarc'];
  spf: string | null;
  dkim: string | null;
  dmarcDomain: string | null;
}

const EMPTY_AUTH: AuthExtraction = { dmarc: 'unknown', spf: null, dkim: null, dmarcDomain: null };

function normalizeDmarc(raw: string | undefined): 'pass' | 'fail' | 'none' | null {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'pass' || normalized === 'fail' || normalized === 'none') return normalized;
  return null;
}

/** Parses one `Authentication-Results` header VALUE per RFC 8601's shape (not a full
 * grammar — just `authserv-id ; resinfo`, pulling `dmarc=`, `spf=`, `dkim=` and
 * `header.from=` out of `resinfo` by name). Returns nulls for anything not present rather
 * than guessing. */
function parseAuthenticationResultsValue(value: string): ParsedAuthResult {
  const semiIdx = value.indexOf(';');
  const authservId = (semiIdx === -1 ? value : value.slice(0, semiIdx)).trim().toLowerCase();
  const resinfo = semiIdx === -1 ? '' : value.slice(semiIdx + 1);

  const dmarcMatch = /\bdmarc\s*=\s*([a-z]+)/i.exec(resinfo);
  const spfMatch = /\bspf\s*=\s*([a-z]+)/i.exec(resinfo);
  const dkimMatch = /\bdkim\s*=\s*([a-z]+)/i.exec(resinfo);
  const domainMatch = /\bheader\.from\s*=\s*([^\s;]+)/i.exec(resinfo);

  return {
    authservId,
    dmarc: normalizeDmarc(dmarcMatch?.[1]),
    spf: spfMatch?.[1]?.toLowerCase() ?? null,
    dkim: dkimMatch?.[1]?.toLowerCase() ?? null,
    dmarcDomain: domainMatch?.[1]?.trim().toLowerCase() ?? null,
  };
}

function authservIdMatches(candidate: string, configured: string): boolean {
  const c = configured.trim().toLowerCase();
  return candidate === c || candidate.endsWith(`.${c}`);
}

/** Parses Mailgun's documented `message-headers` field — a JSON array of `[name, value]`
 * pairs covering every MIME header, in receipt order — into that array, tolerating both
 * an already-parsed array (fake/test payloads) and the JSON-string form the real webhook
 * sends. Returns `[]` for anything else rather than throwing on a malformed payload. */
function parseMessageHeaders(payload: Record<string, unknown>): [string, string][] {
  const raw = payload['message-headers'];
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const entries: [string, string][] = [];
  for (const entry of parsed) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
      entries.push([entry[0], entry[1]]);
    }
  }
  return entries;
}

function messageHeaderNames(headers: [string, string][]): Set<string> {
  return new Set(headers.map(([name]) => name.toLowerCase()));
}

/** Source (b): the topmost `Authentication-Results` entry in `message-headers` whose
 * `authserv-id` names our own receiving host, per the module doc comment above. */
function extractFromMessageHeadersArray(
  headers: [string, string][],
  authservId: string,
): ParsedAuthResult | null {
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== AUTHENTICATION_RESULTS_HEADER) continue;
    const parsed = parseAuthenticationResultsValue(value);
    if (authservIdMatches(parsed.authservId, authservId)) return parsed;
  }
  return null;
}

/** Source (a): the classic lowercase Mailgun-field-shaped guesses, each discarded if the
 * same key also names a `message-headers` entry (see doc comment). */
function extractFromMailgunFields(
  payload: Record<string, unknown>,
  knownHeaderNames: Set<string>,
): AuthExtraction {
  function field(key: string): string | null {
    if (knownHeaderNames.has(key)) return null;
    const value = payload[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }
  return {
    dmarc: normalizeDmarc(field(DMARC_MAILGUN_FIELD) ?? undefined) ?? 'unknown',
    spf: field(SPF_MAILGUN_FIELD),
    dkim: field(DKIM_MAILGUN_FIELD),
    dmarcDomain: field(DMARC_DOMAIN_MAILGUN_FIELD),
  };
}

/** Whether an `AuthExtraction` actually carries a signal (vs. the all-empty shape a miss
 * returns) — used to decide whether source (a) already answered the question, or whether
 * `both` should still fall through to source (b). */
function hasAuthSignal(extraction: AuthExtraction): boolean {
  return (
    extraction.dmarc !== 'unknown' ||
    extraction.spf !== null ||
    extraction.dkim !== null ||
    extraction.dmarcDomain !== null
  );
}

function extractAuthResult(
  payload: Record<string, unknown>,
  config: MailgunMappingConfig,
): AuthExtraction {
  const headers = parseMessageHeaders(payload);
  if (headers.length === 0) {
    // Fix pass 5, F-B step 0 (module doc comment above): the anti-forgery dedup guard is
    // derived entirely from `message-headers` — absent, neither source below can be told
    // apart from an attacker's own MIME header occupying the same flat namespace. Fail
    // closed rather than trust either one on a guess.
    return EMPTY_AUTH;
  }
  const knownHeaderNames = messageHeaderNames(headers);

  if (config.authSource === 'mailgun-fields' || config.authSource === 'both') {
    const fromFields = extractFromMailgunFields(payload, knownHeaderNames);
    if (hasAuthSignal(fromFields)) return fromFields;
    if (config.authSource === 'mailgun-fields') return EMPTY_AUTH;
  }

  if (config.authSource === 'authentication-results' || config.authSource === 'both') {
    const authResult = extractFromMessageHeadersArray(headers, config.authservId);
    if (authResult) {
      return {
        dmarc: authResult.dmarc ?? 'unknown',
        spf: authResult.spf,
        dkim: authResult.dkim,
        dmarcDomain: authResult.dmarcDomain,
      };
    }
  }

  return EMPTY_AUTH;
}

export const DEFAULT_MAILGUN_MAPPING_CONFIG: MailgunMappingConfig = {
  authservId: 'mailgun.org',
  authSource: 'both',
};

/**
 * Extracts the single `From` mailbox, applying F-1/F-3's fixes together:
 *  - `From` is parsed with `parseSingleMailbox` (RFC 5322-ish, `src/lib/email-address.ts`)
 *    instead of the old bracket/bare-address regex — rejects a two-`@` addr-spec, a
 *    multi-mailbox header, and a spoof-shaped display name (RT-04, RT-05, and the
 *    pre-existing display-name-spoof/multi-address regressions).
 *  - RT-03: Mailgun's OWN parsed `from` field (lowercase — its documented synthetic
 *    field, distinct from the raw `From` MIME header) is cross-checked when present and
 *    itself parses cleanly to one mailbox. A disagreement means the pipeline's two
 *    representations of "who sent this" disagree, which is exactly the shape of a header-
 *    injection attempt — treated as no valid From address at all (`fromAddresses = []`),
 *    which pipeline gate 6 already rejects as `from_address_invalid`.
 */
function extractFromAddresses(payload: Record<string, unknown>): string[] {
  const fromValue = payload.From;
  if (typeof fromValue !== 'string' || fromValue.trim() === '') return [];
  const parsedFrom = parseSingleMailbox(fromValue);
  if (!parsedFrom) return [];

  const mailgunFrom = payload.from;
  if (typeof mailgunFrom === 'string' && mailgunFrom.trim() !== '') {
    const parsedMailgunFrom = parseSingleMailbox(mailgunFrom);
    if (parsedMailgunFrom && parsedMailgunFrom.address !== parsedFrom.address) {
      return []; // RT-03: `From` and `from` disagree — reject rather than pick one
    }
  }

  return [parsedFrom.address];
}

export function mapMailgunInboundPayload(
  payload: Record<string, unknown>,
  config: MailgunMappingConfig = DEFAULT_MAILGUN_MAPPING_CONFIG,
): InboundMessage {
  const recipientRaw = String(payload.recipient ?? '')
    .trim()
    .toLowerCase();
  const fromAddresses = extractFromAddresses(payload);
  const providerMessageId = String(payload['Message-Id'] ?? payload['message-id'] ?? '');
  const signatureToken = String(payload.token ?? '');
  const subject = typeof payload.subject === 'string' ? payload.subject : null;
  const bodyPlain =
    typeof payload['body-plain'] === 'string' ? (payload['body-plain'] as string) : null;

  const auth = extractAuthResult(payload, config);

  return {
    providerMessageId,
    signatureToken,
    recipientRaw,
    fromAddresses,
    dmarc: auth.dmarc,
    spf: auth.spf,
    dkim: auth.dkim,
    dmarcDomain: auth.dmarcDomain,
    subject,
    bodyPlain,
    rawPayload: payload,
  };
}
