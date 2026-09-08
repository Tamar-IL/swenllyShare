# Swenlly Share

Swenlly Share is a filter-proof file-distribution product for two audiences a normal public link
(S3, Dropbox, a SaaS "download" page) fails outright: people on **filtered internet**
(NetFree/Rimon/Netspark, domain-whitelist filters) and people on **email-only** internet (Google
services only, no general web). One upload returns: a **distribution link** (filtered-internet
path), a **`mailto:` email-request link** (email-only path — reply carries the file, no Google
account needed), and **settings** (reply message, display name, expiry). A **Swenlly-branded embed
page** is the white-label goal, shipped behind `BRANDED_PAGE_ENABLED` (default `false`) until
`swenlly.com` and Zoho's embed subdomain are whitelisted by the filters — until then the
distribution link is the raw Zoho WorkDrive public link, which already passes the filter today.

Product definition: [`docs/01-prd-file-sharing.md`](docs/01-prd-file-sharing.md); reading order and
precedence: [`docs/00-README.md`](docs/00-README.md).

## Status: built, unverified against live providers

**312 tests pass** (`pnpm test`, real Postgres + semantic fakes for every provider). **Zero live
calls have been made to Google Drive, Zoho WorkDrive, or Mailgun by anyone on this project** —
every real adapter method is `@unverified-live` in
[`docs/verification-ledger.md`](docs/verification-ledger.md) (generated from those markers, CI
checks it can't drift). Turning a method verified needs a manual, credentialed run — see
[`docs/runbooks/live-spikes.md`](docs/runbooks/live-spikes.md) for the four spikes confirming
Zoho's link API, Drive's real share ceiling, Mailgun's DMARC field, and branded-page rendering
inside a real filter. The app refuses to boot with a fake adapter when `NODE_ENV=production`.

## Quickstart

```bash
scripts/dev-db.sh start        # ephemeral Postgres 16 on 127.0.0.1:54329
cp .env.example .env           # fill in SESSION_SECRET (32+ chars); rest has dev defaults
ADAPTERS=fake pnpm dev          # tsx watch, zero external credentials
curl localhost:3000/healthz    # {"ok":true}
```

`pnpm dev` migrates automatically at boot; with `ADAPTERS=fake` the full upload → links → settings
→ audit-log flow works end to end, no credentials.

```bash
export TEST_DATABASE_URL="$(scripts/dev-db.sh url | grep TEST_ | cut -d= -f2-)"
pnpm test              # unit + integration, real Postgres — no pglite/SQLite path exists
```

Production checklist + DNS: [`docs/runbooks/run-and-deploy.md`](docs/runbooks/run-and-deploy.md).

## Repo map

```
src/  server.ts app.ts worker.ts container.ts config.ts   entry points, DI, env schema
      http/     routes + plugins (auth, csrf, security headers, errors)
      domain/   Files, Links, Settings, RequestPipeline, SharingEngine, Audit, RateLimit, Auth
      ports/    interfaces only
      adapters/ one real.ts + fake.ts per provider (zoho, google, mailgun, staging, system)
      db/       pool, migrate.ts, migrations/*.sql, tenant-scoped repositories
      jobs/     worker loop (SKIP LOCKED) + handlers (publish, deliver, expire, purge)
      views/, public/  Eta SSR templates + one vanilla-JS island
      lib/      framework-free helpers
tests/  unit, integration (real Postgres), contract (per-port), redteam, qa
scripts/  dev-db.sh, gen-verification-ledger.ts
```

Boundary rules (review + lint enforced): **`http/`** parses/authorizes/calls one service/renders —
no business logic, no SQL. **`domain/`** imports only a port interface, never an adapter. **`db/`**
only repositories issue SQL, every tenant method takes `tenantId` first. **`adapters/`** translate
protocol ↔ DTO; policy lives in `domain/`.

Design rationale: [architecture.md](docs/design/architecture.md); decision log:
[decisions.md](docs/decisions.md).

**`docs/`:** [`design/`](docs/design/) (advisor + architecture + UX) ·
[`security/`](docs/security/) (red-team + appsec) · [`qa/`](docs/qa/) ·
[`reviews/`](docs/reviews/) (code review) · [`runbooks/`](docs/runbooks/) (deploy + live spikes) ·
[`verification-ledger.md`](docs/verification-ledger.md) · [`decisions.md`](docs/decisions.md) ·
[`progress.md`](docs/progress.md) · [`lessons.md`](docs/lessons.md).

## Environment variables

From `src/config.ts` (zod, fails fast at boot). No secrets below — copy `.env.example` and fill
real values locally/in a secret manager.

**Core** — `NODE_ENV`=development (prod disables fakes, forces secure cookies) · `PORT`=3000 ·
`LOG_LEVEL`=info · `PUBLIC_BASE_URL`/`INBOUND_DOMAIN` required · `DATABASE_URL` required ·
`PGPOOL_MAX`=10 · `PG_SSL`=false (prod requires this or `sslmode=require+`) · `SESSION_SECRET`
required, 32+ chars · `COOKIE_SECURE` derived from `NODE_ENV` · `ADAPTERS`=fake ·
`ADAPTER_OVERRIDES` dev-only, e.g. `"drive=fake,zoho=real"`.

**Limits** — `ATTACH_LIMIT_BYTES`=20MB (attachment vs. Drive-share threshold) ·
`MAX_UPLOAD_BYTES`=1GB (founder-open, see below) · `STAGING_DIR`=./staging,
`STAGING_RETENTION_HOURS`=24 · `DRIVE_SHARE_SOFT_CAP`=500, `SHARE_PACE_MIN_INTERVAL_MS`=1500
(auto-duplication margin + pacing) · `DEFAULT_EXPIRY_DAYS`=30 ·
`RATE_REQUESTER/FILE/TENANT/DOMAIN_PER_HOUR`=5/60/300/30 (sliding-window inbound limits) ·
`RATE_MAGICLINK_PER_HOUR`=5 (sign-in, per IP+email) · `RAW_PAYLOAD_RETENTION_DAYS`=7 ·
`QUARANTINE_PER_TOKEN_PER_HOUR`=5 (caps unauthenticated writes) · `WEBHOOK_BODY_LIMIT_BYTES`=2MB
(enforced pre-parse) · `WORKER_CONCURRENCY`=4, `JOB_MAX_ATTEMPTS`=8.

**Providers** — `GOOGLE_CREDENTIAL_MODE`=service_account|oauth_refresh + SA/OAuth vars (Workspace SA
or no-Workspace fallback) · `ZOHO_CLIENT_ID`/`_SECRET`/`_REFRESH_TOKEN`, `ZOHO_API_BASE`/
`_ACCOUNTS_BASE`, `ZOHO_TEAM_FOLDER_ID`, `ZOHO_LINK_ROLE_ID`=6 (WorkDrive OAuth + DC host + folder

- link role) · `MAILGUN_API_BASE`/`_API_KEY`/`_SIGNING_KEY`/`_SENDING_DOMAIN`, `OUTBOUND_FROM` ·
  `MAILGUN_AUTHSERV_ID` (defaults to `INBOUND_DOMAIN` — a guess until spike 3),
  `INBOUND_AUTH_SOURCE`=both (which source(s) the DMARC mapper trusts).

**Flags** — `BRANDED_PAGE_ENABLED`=false (branded page vs. raw Zoho link; `/s/*` 404s while off) ·
`WORKER_ENABLED`=true · `INBOUND_REQUESTS_ENABLED`=true (kill switch — `false` quarantines inbound
mail before the DMARC gate, no deploy needed).

## Security model

- **DMARC from provider-asserted results only.** Read only from Mailgun's `Authentication-Results`
  entry or an allowlisted field set — never the flat namespace attacker-controlled MIME headers
  also occupy; a `pass` with no domain to align against is quarantined.
- **Token-only file resolution.** An address resolves to a file by its opaque `request_token`
  alone — never subject/body/slug; the distribution link's `public_slug` is a separate token.
- **Deliver to the verified From address only.** Reply-To/Sender/Cc/Bcc/body-named addresses are
  ignored.
- **Rate limits at every level.** Per requester, requester-domain, file, and tenant — Postgres
  sliding windows — so no address trick or domain can exhaust a budget.
- **Audit log and a kill switch.** Every attempt is logged and queryable per file;
  `INBOUND_REQUESTS_ENABLED` holds the inbound path shut with no deploy.

Findings + fix status: [red-team](docs/security/red-team-report.md),
[appsec](docs/security/appsec-review.md).

## Deferred (PRD §7)

The branded page as **live default** (gated on `swenlly.com` whitelisting); the
**sender's-own-account** power tier (pending confirmation, re-introduces per-sender OAuth);
large-file delivery to a recipient with **no Google account at all**; folders, versioning,
analytics, payments, collaboration.

## Open questions for the founder

From [PRD §10](docs/01-prd-file-sharing.md#10-open-questions-for-the-founder-unresolved--not-guessed):
own-account power tier; `swenlly.com` whitelisting status/SLA + embed spike outcome; live
confirmation of the Zoho link/upload API; Google account type + real share ceiling; default expiry
window and the no-Google-account gap. Plus two forks from
[architecture.md §12](docs/design/architecture.md#12-top-tradeoffs-risks-and-what-i-did-not-verify):

- **Google account type → AC-R4.** Email-OTP visitor sharing is Workspace-only; a consumer Gmail
  central account degrades AC-R4 to "recipient needs a Google account" — a product decision.
- **Upload ceiling.** `MAX_UPLOAD_BYTES` defaults to 1 GB; the UX brief's "5 GB" is a placeholder
  pending the real Zoho plan limit.
