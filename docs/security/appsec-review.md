# AppSec Review — Swenlly System 2

**Owner:** appsec-engineer · **Date:** 2026-09-08 · **Scope:** everything the red team did not cover
(sender web app, upload, branded page + download, JSON APIs, adapters, data layer, supply chain).
Three red-team fixes were spot-checked at HEAD (F-1 mapping rewrite, F-6 CAS, F-10/F-11) — all hold.

## Verdict

Not a green light as-is: two must-fix items (both small). Everything else is should-fix /
defense-in-depth. **Fix status is tracked in the last column.**

## Findings

| # | Sev | Finding | Location | Remediation | Status |
|---|---|---|---|---|---|
| 1 | HIGH | `.gitignore` `staging/` (unanchored) also ignores `src/adapters/staging/`, so the disk staging adapter was never committed; a clean clone / CI cannot typecheck and the raw-filesystem upload code bypassed review | `.gitignore:4`, `src/adapters/staging/real.ts` | Anchor to `/staging/`, commit the adapter | **Fixed** (orchestrator, same day) |
| 2 | HIGH | Magic-link sign-in rate-limited per IP only; `magicLinks.countRequestedSince` exists but is never called → email-bombing arbitrary third parties from rotating IPs | `src/domain/auth.ts`, `src/http/routes/signin.ts`, `src/db/repositories/magic-links.ts:52` | Per-email sliding-window limit in `requestMagicLink` before mint/send | Fix pass 2 |
| 3 | MED | Zoho hand-rolled multipart builder sanitizes the file-part filename but not plain field values → CRLF/boundary injection into the outbound Zoho call (mitigated today by a random 128-bit boundary) | `src/adapters/zoho/real.ts:109-142` | Strip `\r`/`\n` from every field value, or use native `FormData` like the Mailgun adapter | **Fixed** (fix pass 3) |
| 4 | MED | No MIME allowlist at upload; stored `mime` flows into the download `Content-Type` header (control chars → 500 on every download) | `src/domain/files.ts` (`createStaged`), `src/http/routes/public-share.ts:62-65` | Normalize/allowlist at upload time; strip control characters | **Fixed** (fix pass 3) |
| 5 | LOW | No CR/LF stripping on `display_name` / `custom_message` before they become an outbound `subject` / attachment filename | `src/domain/reply-composer.ts`, `src/domain/settings.ts` | Strip CR/LF/control chars at settings validation | **Fixed** (fix pass 3) |
| 6 | LOW | No max length on `displayName` / `customMessage` | `src/domain/settings.ts` | Cap (255 / ~5000) | **Fixed** (fix pass 3) |
| 7 | LOW | `pg.Pool` has no explicit `ssl`; TLS to Postgres depends solely on `DATABASE_URL` | `src/db/pool.ts` | Fail fast in production unless the URL demands TLS or `PGSSL_REQUIRE` is set | **Fixed** (fix pass 3) |
| 8 | INFO | Login CSRF on `GET /auth/callback` — inherent to clickable links; bounded impact (attacker's own tenant only), framing blocked | `src/http/routes/signin.ts:47-68` | Accepted tradeoff | Accepted |
| 9 | INFO | PII (requester/from addresses, magic-link email) stored in plaintext — required by AC-A2; residual risk for hosting/GRC (encryption at rest) | DB | Hosting-layer control | Noted |

## Checked and clean

| Area | Files | Result |
|---|---|---|
| Session/cookie config | `src/http/plugins/auth.ts` | `httpOnly`, `Secure` outside dev, `SameSite=Lax`, signed, sliding refresh |
| CSRF | `src/http/plugins/csrf.ts`, all POST routes | Double-submit enforced; webhook exempt by routing, not a flag |
| Upload size caps | `src/lib/byte-limit.ts`, `src/domain/files.ts` | Streamed, hard-capped at the domain layer, partial blob cleaned up |
| Staging path handling | `src/adapters/staging/real.ts` | Server-generated ids only, `SAFE_ID_RE`, streamed writes |
| Tenant isolation / IDOR | all repositories, `api-files.ts`, `files.ts` | Every statement filters `tenant_id` except the two documented resolvers |
| SQL injection | every repository | 100% parameterized |
| XSS in Eta | all `src/views/*.eta` | `autoEscape` on; every user value via `<%=`; the one `<%~ it.body %>` receives only rendered escaped templates |
| Client JS | `src/public/island.js` | No `innerHTML`/`eval` sinks |
| `Content-Disposition` | `src/lib/content-disposition.ts` | Control chars/quotes stripped; RFC 5987 form encoded |
| mailto builder / address grammar | `src/lib/mailto.ts`, `src/lib/addressing.ts` | `encodeURIComponent`; anchored regex |
| Secrets/config | `src/config.ts`, `.env.example` | Zod fail-fast, no hardcoded secrets, `SESSION_SECRET` min length |
| Log redaction | `src/app.ts` | authorization, cookie, signature, csrf, sensitive bodies |
| Google adapter | `src/adapters/google/real.ts` | `drive.file` scope, JSON bodies, `q=` literal escaping, no TLS overrides |
| Mailgun adapters | `src/adapters/mailgun/*` | `timingSafeEqual`, native `FormData`, creds never logged |
| Dockerfile / CI | `Dockerfile`, `.github/workflows/ci.yml` | Non-root, multi-stage, least-privilege `permissions` |
| Dependencies | `pnpm audit --prod` | 0 known vulnerabilities (125 prod deps) |
| Token generation | `src/lib/base32.ts` | CSPRNG, bit-exact truncation |
