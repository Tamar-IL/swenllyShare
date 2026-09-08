import { domainToASCII } from 'node:url';

/**
 * A small, deliberately narrow RFC 5322 `From`-header mailbox parser (F-3,
 * `docs/security/red-team-report.md`). It replaces the old approach of scraping
 * `<...>`/bare-address patterns out of the raw header text with something that actually
 * understands display names, quoting, comments, and a comma-separated mailbox list — so
 * `victim@corp.test@attacker.test` (two `@`s) and `<a@x>, <b@y>` (two mailboxes) are
 * rejected as malformed rather than silently accepted on whichever `@` or bracket the old
 * regex happened to find first.
 *
 * This is NOT a general-purpose RFC 5322 parser — no folding whitespace across lines, no
 * nested comments, no obsolete syntax. It is exactly as permissive as the mailboxes this
 * product actually needs to accept (a plain address, or "Display Name" <addr>), and it
 * fails closed (returns `null`) on anything it cannot parse with confidence, which is
 * always the safe direction for an authentication-adjacent field.
 */

export interface ParsedMailbox {
  /** Lowercased `local@domain`, IDN domain normalized to ASCII (punycode). */
  address: string;
  /** The domain half of `address` (already lowercased/ASCII-normalized). */
  domain: string;
}

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
// A display name that itself contains something address-shaped is a classic spoofing
// pattern (`"victim@real.com" <attacker@evil.com>`) — architecture.md §4.6 / the red-team
// report's own "BLOCKED: display-name spoof" regression treats this as invalid, not as
// "one address with a decorative name", even though a strict RFC 5322 reading would allow
// it. This is a deliberate, documented stricter-than-RFC choice: reject the whole header
// rather than silently trust whichever address a client renders. See F-3's report note on
// the (accepted) false-reject cost for a real user who puts an address in their display
// name — DMARC alignment already recovers this case is not so, so the tradeoff is worth it
// for a field this security-sensitive.
const ADDRESS_LOOKING_RE = /[^\s@]+@[^\s@]+/;

/** Splits `value` into top-level comma-separated segments, honoring quoted strings and
 * parenthesized comments so a comma inside `"Doe, John"` does not split the mailbox. */
function splitMailboxes(value: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inQuotes = false;
  let commentDepth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuotes) {
      current += ch;
      if (ch === '\\' && i + 1 < value.length) {
        current += value[++i];
        continue;
      }
      if (ch === '"') inQuotes = false;
      continue;
    }
    if (commentDepth > 0) {
      current += ch;
      if (ch === '(') commentDepth++;
      else if (ch === ')') commentDepth--;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      current += ch;
      continue;
    }
    if (ch === '(') {
      commentDepth++;
      current += ch;
      continue;
    }
    if (ch === ',') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/** Strips one or more `(...)` comments from `segment`, respecting quoted strings so a
 * `(` inside a quoted display name is not treated as a comment opener. */
function stripComments(segment: string): string {
  let result = '';
  let inQuotes = false;
  let depth = 0;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (inQuotes) {
      result += ch;
      if (ch === '\\' && i + 1 < segment.length) {
        result += segment[++i];
        continue;
      }
      if (ch === '"') inQuotes = false;
      continue;
    }
    if (depth > 0) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      result += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    result += ch;
  }
  return result;
}

/** Parses one mailbox segment (no top-level comma) into `{displayName, addrSpec}`, or
 * `null` if brackets are unbalanced/empty. `addrSpec` is untrimmed, unvalidated. */
function splitDisplayNameAndAddrSpec(
  segment: string,
): { displayName: string; addrSpec: string } | null {
  let inQuotes = false;
  let angleStart = -1;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '\\' && inQuotes) {
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === '<') {
      angleStart = i;
      break;
    }
  }
  if (angleStart === -1) {
    // Bare form: the whole (comment-stripped) segment is the addr-spec.
    return { displayName: '', addrSpec: segment };
  }
  const angleEnd = segment.indexOf('>', angleStart + 1);
  if (angleEnd === -1) return null; // unbalanced bracket — malformed
  return {
    displayName: segment.slice(0, angleStart),
    addrSpec: segment.slice(angleStart + 1, angleEnd),
  };
}

function parseOneMailbox(rawSegment: string): ParsedMailbox | null {
  const segment = stripComments(rawSegment).trim();
  if (segment === '') return null;

  const split = splitDisplayNameAndAddrSpec(segment);
  if (!split) return null;

  const displayName = split.displayName.trim();
  if (ADDRESS_LOOKING_RE.test(displayName)) return null; // spoof-shaped display name

  const addrSpec = split.addrSpec.trim();
  // A quoted local-part ("john doe"@example.com) is legal RFC 5322 but never something
  // this product's own request-address grammar or Mailgun's synthetic fields produce —
  // treat it defensively as malformed rather than unquoting it.
  if (addrSpec.startsWith('"')) return null;
  if (CONTROL_CHAR_RE.test(addrSpec) || /\s/.test(addrSpec)) return null;
  if (addrSpec.includes('<') || addrSpec.includes('>') || addrSpec.includes(',')) return null;

  const atCount = (addrSpec.match(/@/g) ?? []).length;
  if (atCount !== 1) return null; // F-3: reject 0 or 2+ `@` rather than guessing which one

  const at = addrSpec.lastIndexOf('@');
  const local = addrSpec.slice(0, at);
  const domainRaw = addrSpec.slice(at + 1);
  if (local === '' || domainRaw === '') return null;

  const asciiDomain = domainToASCII(domainRaw.toLowerCase());
  if (asciiDomain === '') return null; // domainToASCII rejects a malformed domain as ''

  return { address: `${local.toLowerCase()}@${asciiDomain}`, domain: asciiDomain };
}

/**
 * Parses an RFC 5322 `From`-header VALUE (no `"From:"` prefix) into every mailbox it
 * names. Returns `null` if the header contains a raw control character, or if ANY
 * individual mailbox fails to parse cleanly — the pipeline's gate 6 (architecture.md
 * §4.6) needs "exactly one mailbox, well-formed" and treats zero, malformed, or multiple
 * results identically (`from_address_invalid`), so a single `null` return covers all of
 * those without the caller needing to know which sub-case fired.
 */
export function parseMailboxList(headerValue: string): ParsedMailbox[] | null {
  if (CONTROL_CHAR_RE.test(headerValue)) return null;
  const segments = splitMailboxes(headerValue);
  const mailboxes: ParsedMailbox[] = [];
  for (const segment of segments) {
    const parsed = parseOneMailbox(segment);
    if (!parsed) return null;
    mailboxes.push(parsed);
  }
  if (mailboxes.length === 0) return null;
  return mailboxes;
}

/** Parses `headerValue` and returns the single mailbox it names, or `null` if it names
 * zero mailboxes, more than one, or anything malformed. Convenience wrapper around
 * `parseMailboxList` for the (overwhelmingly common) exactly-one-address case. */
export function parseSingleMailbox(headerValue: string): ParsedMailbox | null {
  const list = parseMailboxList(headerValue);
  if (!list || list.length !== 1) return null;
  return list[0] ?? null;
}

/** The domain half of an already-normalized `local@domain` address (last `@`, matching
 * how SMTP actually routes — see F-3). Callers that already hold a `ParsedMailbox` should
 * use its `.domain` instead; this is for values (e.g. `deliveries.requester_address`)
 * that only ever reach later code as a plain string. */
export function addressDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1);
}
