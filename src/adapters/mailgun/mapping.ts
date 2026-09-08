import type { InboundMessage } from '../../ports/inbound-mail.js';
import { parseSingleMailbox } from '../../lib/email-address.js';

/**
 * Maps Mailgun's raw inbound-route form payload into our normalized `InboundMessage` DTO.
 *
 * `recipient`, `from`/`From`, `subject`, `body-plain`, `Message-Id`, `timestamp` and
 * `token` are Mailgun's own stable, documented webhook field names (Routes / Store-and-
 * notify), not a guess.
 *
 * ## Authentication results — the threat model this file is written against
 *
 * Mailgun's inbound routes flatten EVERY MIME header of the received message into the same
 * POST namespace that carries Mailgun's own synthetic fields, and list those MIME headers
 * again, in receipt order, in the `message-headers` JSON array. Everything a requester can
 * type into their outgoing message therefore arrives here twice: once flattened (where it
 * is indistinguishable from a synthetic field by name alone) and once inside
 * `message-headers` (where it is labelled as a MIME header). The `authserv-id` a receiving
 * MTA writes into `Authentication-Results` is its own PUBLIC hostname — anyone can put it
 * in a forged header (`docs/reviews/critic-report.md` F-B re-check, attacks C′/C″/F).
 *
 * The properties this code guarantees (F-1 → F-B, fix passes 5 and 6):
 *
 *   0. **No `message-headers`, no verdict.** Every auth field reads `unknown`/`null`.
 *      Without the MIME-header list the flattened namespace cannot be classified at all.
 *   1. **One explicit source, chosen by the operator after spike 3** (`INBOUND_AUTH_SOURCE`
 *      = `mailgun-fields` | `authentication-results`). There is no "try one, fall back to
 *      the other": a fallback is a second door, and an attacker who can jam the first door
 *      gets to pick which one answers (critic N-1).
 *   2. **Source (a), `mailgun-fields`** — Mailgun's synthetic `dmarc` / `spf` / `dkim` /
 *      `dmarc-domain` fields (exact lowercase, Mailgun's naming convention). If ANY of those
 *      four names also appears in `message-headers`, the source is AMBIGUOUS (the flattened
 *      copy may be the sender's own header) and the verdict is `unknown` — never "skip
 *      this field", never "try the other source".
 *   3. **Source (b), `authentication-results`** — the RFC 8601 header, read ONLY from
 *      `message-headers`. Trusted only when EXACTLY ONE entry names the configured
 *      `MAILGUN_AUTHSERV_ID` by exact, case-insensitive string equality (no DNS-suffix
 *      matching — attack C″). Two entries naming it ⇒ AMBIGUOUS ⇒ `unknown`, regardless of
 *      order (so this does not depend on the receiving MTA prepending). Zero ⇒ absent.
 *   4. **Cross-check, fail closed.** Whichever source is authoritative, if the OTHER source
 *      is present and its DMARC verdict disagrees, the result is `unknown`; if the other
 *      source is ambiguous, the result is `unknown`. A forged header can therefore only ever
 *      DOWNGRADE a verdict (quarantine the attacker's own request), never upgrade it.
 *
 * **Residual, stated plainly (not fixable in code):** in `authentication-results` mode, if
 * Mailgun does NOT stamp its own `Authentication-Results` on a message and the sender
 * forges exactly one naming our public authserv-id, it is indistinguishable from a genuine
 * stamp. That mode is therefore only safe if spike 3 (`docs/runbooks/live-spikes.md`)
 * proves Mailgun stamps its own header on EVERY message — including one that already
 * carries a forged copy (then there are two, and rule 3 quarantines). If spike 3 cannot
 * prove that, use `mailgun-fields`; if Mailgun provides neither signal, the inbound path
 * must stay closed (`INBOUND_REQUESTS_ENABLED=false`, the default).
 *
 * **This is still `@unverified-live`** (architecture.md §12): nobody on this project has
 * inspected a real Mailgun inbound payload.
 */
const DMARC_MAILGUN_FIELD = 'dmarc';
const SPF_MAILGUN_FIELD = 'spf';
const DKIM_MAILGUN_FIELD = 'dkim';
const DMARC_DOMAIN_MAILGUN_FIELD = 'dmarc-domain';
const MAILGUN_AUTH_FIELDS = [
  DMARC_MAILGUN_FIELD,
  SPF_MAILGUN_FIELD,
  DKIM_MAILGUN_FIELD,
  DMARC_DOMAIN_MAILGUN_FIELD,
] as const;
const AUTHENTICATION_RESULTS_HEADER = 'authentication-results';

export type InboundAuthSource = 'authentication-results' | 'mailgun-fields';

export interface MailgunMappingConfig {
  /** The receiving host name Mailgun's own `Authentication-Results` header names
   * (RFC 8601 `authserv-id`). Matched by exact, case-insensitive equality only. */
  authservId: string;
  authSource: InboundAuthSource;
}

interface AuthExtraction {
  dmarc: InboundMessage['dmarc'];
  spf: string | null;
  dkim: string | null;
  dmarcDomain: string | null;
}

/** One source's reading of the payload. `absent`: nothing there. `ambiguous`: something
 * is there but an attacker could have put it there. `present`: a value this source
 * vouches for. */
type SourceReading =
  | { status: 'absent' }
  | { status: 'ambiguous'; why: string }
  | { status: 'present'; auth: AuthExtraction };

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
function parseAuthenticationResultsValue(value: string): {
  authservId: string;
  auth: AuthExtraction;
} {
  const semiIdx = value.indexOf(';');
  const authservId = (semiIdx === -1 ? value : value.slice(0, semiIdx)).trim().toLowerCase();
  const resinfo = semiIdx === -1 ? '' : value.slice(semiIdx + 1);

  const dmarcMatch = /\bdmarc\s*=\s*([a-z]+)/i.exec(resinfo);
  const spfMatch = /\bspf\s*=\s*([a-z]+)/i.exec(resinfo);
  const dkimMatch = /\bdkim\s*=\s*([a-z]+)/i.exec(resinfo);
  const domainMatch = /\bheader\.from\s*=\s*([^\s;]+)/i.exec(resinfo);

  return {
    authservId,
    auth: {
      dmarc: normalizeDmarc(dmarcMatch?.[1]) ?? 'unknown',
      spf: spfMatch?.[1]?.toLowerCase() ?? null,
      dkim: dkimMatch?.[1]?.toLowerCase() ?? null,
      dmarcDomain: domainMatch?.[1]?.trim().toLowerCase() ?? null,
    },
  };
}

/** Exact, case-insensitive equality only — a DNS-suffix match would let
 * `evil.<our-host>` pass (critic F-B re-check, attack C″). */
function authservIdMatches(candidate: string, configured: string): boolean {
  return candidate === configured.trim().toLowerCase();
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

/** Source (b): `Authentication-Results` entries inside `message-headers`. Present only
 * when exactly one entry names our authserv-id (rule 3 in the module doc comment). */
function readAuthenticationResults(headers: [string, string][], authservId: string): SourceReading {
  const ours: AuthExtraction[] = [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== AUTHENTICATION_RESULTS_HEADER) continue;
    const parsed = parseAuthenticationResultsValue(value);
    if (authservIdMatches(parsed.authservId, authservId)) ours.push(parsed.auth);
  }
  if (ours.length === 0) return { status: 'absent' };
  if (ours.length > 1) {
    return { status: 'ambiguous', why: 'multiple Authentication-Results name our authserv-id' };
  }
  return { status: 'present', auth: ours[0] as AuthExtraction };
}

/** Source (a): Mailgun's synthetic top-level auth fields. Ambiguous if any of their names
 * also appears as a MIME header of the message (rule 2). */
function readMailgunFields(
  payload: Record<string, unknown>,
  knownHeaderNames: Set<string>,
): SourceReading {
  const collisions = MAILGUN_AUTH_FIELDS.filter((key) => knownHeaderNames.has(key));
  if (collisions.length > 0) {
    return {
      status: 'ambiguous',
      why: `MIME header(s) collide with synthetic field(s): ${collisions.join(', ')}`,
    };
  }
  function field(key: string): string | null {
    const value = payload[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }
  const dmarcRaw = field(DMARC_MAILGUN_FIELD);
  const auth: AuthExtraction = {
    dmarc: normalizeDmarc(dmarcRaw ?? undefined) ?? 'unknown',
    spf: field(SPF_MAILGUN_FIELD),
    dkim: field(DKIM_MAILGUN_FIELD),
    dmarcDomain: field(DMARC_DOMAIN_MAILGUN_FIELD),
  };
  const anySignal =
    dmarcRaw !== null || auth.spf !== null || auth.dkim !== null || auth.dmarcDomain !== null;
  return anySignal ? { status: 'present', auth } : { status: 'absent' };
}

/** Rule 4: the authoritative source's verdict, unless the other source is ambiguous or
 * present-and-disagreeing on DMARC — then `unknown`. */
function combine(authoritative: SourceReading, other: SourceReading): AuthExtraction {
  if (authoritative.status !== 'present') return EMPTY_AUTH;
  if (other.status === 'ambiguous') return EMPTY_AUTH;
  if (other.status === 'present' && other.auth.dmarc !== authoritative.auth.dmarc) {
    return EMPTY_AUTH;
  }
  return authoritative.auth;
}

function extractAuthResult(
  payload: Record<string, unknown>,
  config: MailgunMappingConfig,
): AuthExtraction {
  const headers = parseMessageHeaders(payload);
  if (headers.length === 0) return EMPTY_AUTH; // rule 0
  const knownHeaderNames = messageHeaderNames(headers);

  const fields = readMailgunFields(payload, knownHeaderNames);
  const authResults = readAuthenticationResults(headers, config.authservId);

  return config.authSource === 'mailgun-fields'
    ? combine(fields, authResults)
    : combine(authResults, fields);
}

export const DEFAULT_MAILGUN_MAPPING_CONFIG: MailgunMappingConfig = {
  authservId: 'mailgun.org',
  authSource: 'mailgun-fields',
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
