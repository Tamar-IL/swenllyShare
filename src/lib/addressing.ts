/**
 * The inbound request-address grammar (architecture.md §4.3):
 *
 *   cust-<slug>+file-<token>@<INBOUND_DOMAIN>
 *
 * We EMIT the `+` form. We ACCEPT `+` or `--` on parse, because a minority of MUAs and
 * forwarding rules mangle `+` in a local part. `slug` is a tenant's inbound-address slug
 * (`tenants.slug`, base32, 6-32 chars); `token` is a file's `request_token` (base32, fixed
 * 26 chars — 130 bits, see `lib/base32.ts` `opaqueTokenExact`). Matching is
 * case-insensitive; both emit and parse normalize to lowercase.
 *
 * This grammar is the ONLY way an inbound address resolves to a file (architecture.md §3
 * invariant 2) — never the subject, body, `To:`, or tenant slug alone.
 */

const SLUG_PATTERN = '[a-z0-9]{6,32}';
const TOKEN_PATTERN = '[a-z0-9]{26}';

export interface ParsedRequestAddress {
  slug: string;
  token: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Builds the emitted (`+`) form of a request address for `slug`/`token` at `inboundDomain`. */
export function buildRequestAddress(slug: string, token: string, inboundDomain: string): string {
  return `cust-${slug.toLowerCase()}+file-${token.toLowerCase()}@${inboundDomain.toLowerCase()}`;
}

/**
 * Parses an envelope-recipient address into `{slug, token}`, accepting either the `+` or
 * `--` separator, and requiring the domain to match `expectedDomain` (`INBOUND_DOMAIN`)
 * EXACTLY — architecture.md §4.3's grammar embeds the literal configured domain in the
 * regex, not a wildcard capture, so a lookalike domain is rejected here defensively even
 * though Mailgun's own route (`match_recipient`) should never deliver one. Returns `null`
 * for anything that does not match — architecture.md §4.3 gate 3 → HTTP 406.
 * Case-insensitive; always lowercases first.
 */
export function parseRequestAddress(
  address: string,
  expectedDomain: string,
): ParsedRequestAddress | null {
  const re = new RegExp(
    `^cust-(${SLUG_PATTERN})(?:\\+|--)file-(${TOKEN_PATTERN})@${escapeRegExp(expectedDomain.toLowerCase())}$`,
  );
  const match = re.exec(address.trim().toLowerCase());
  if (!match) return null;
  const [, slug, token] = match;
  if (!slug || !token) return null;
  return { slug, token };
}
